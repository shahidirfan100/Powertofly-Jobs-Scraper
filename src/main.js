import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';
import { load as cheerioLoad } from 'cheerio';

const SEARCH_ENDPOINT = 'https://search.prd.powertofly.com/jobs/search';
const DETAIL_BASE = 'https://powertofly.com/jobs/detail/';
const DEFAULT_HEADERS = {
    'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'accept-language': 'en-US,en;q=0.9',
};

function buildCookieHeader({ cookies, cookiesJson }) {
    const parts = [];
    if (cookies && typeof cookies === 'string') parts.push(cookies.trim());

    if (cookiesJson) {
        try {
            const parsed = typeof cookiesJson === 'string' ? JSON.parse(cookiesJson) : cookiesJson;
            if (Array.isArray(parsed)) {
                parsed.forEach(({ name, value }) => {
                    if (name && value) parts.push(`${name}=${value}`);
                });
            } else if (parsed && typeof parsed === 'object') {
                Object.entries(parsed).forEach(([k, v]) => {
                    if (k && v) parts.push(`${k}=${v}`);
                });
            }
        } catch (err) {
            log.warning(`Failed to parse cookiesJson: ${err.message}`);
        }
    }

    const header = parts.filter(Boolean).join('; ');
    return header || undefined;
}

function cleanText(html) {
    if (!html) return null;
    const $ = cheerioLoad(html);
    const txt = $('body').length ? $('body').text() : $.root().text();
    return txt.replace(/\s+/g, ' ').trim() || null;
}

function normalizeLocation(raw) {
    if (!raw) {
        return { location: null, is_remote: null, remote_type: null, region: null };
    }

    let text = String(raw).trim().replace(/[\[\]]/g, '');
    const parts = text.split(/[|/,-]/).map((p) => p.trim()).filter(Boolean);

    let isRemote = false;
    let remoteType = null;
    const locations = [];

    for (const p of parts) {
        if (p.toLowerCase().includes('remote')) {
            isRemote = true;
            if (!remoteType) remoteType = p;
        } else {
            locations.push(p);
        }
    }

    const joined = locations.join(' / ') || null;

    return {
        location: joined,
        is_remote: isRemote || null,
        remote_type: remoteType || null,
        region: joined,
    };
}

function parseJsonLd($) {
    const raw = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        const text = $(el).contents().text().trim();
        if (!text) return;
        try {
            const json = JSON.parse(text);
            if (Array.isArray(json)) raw.push(...json);
            else raw.push(json);
        } catch {
            // ignore invalid JSON
        }
    });

    const flattened = raw.flatMap((o) => (o && o['@graph'] ? o['@graph'] : [o]));

    const job = flattened.find((o) => {
        const t = o && o['@type'];
        if (!t) return false;
        if (Array.isArray(t)) return t.includes('JobPosting');
        return t === 'JobPosting';
    });

    if (!job) return null;

    const data = {};
    if (job.title) data.title = String(job.title).trim();
    if (job.description) data.description_html = String(job.description).trim();

    if (job.hiringOrganization && job.hiringOrganization.name) {
        data.company = String(job.hiringOrganization.name).trim();
    }

    if (job.jobLocation) {
        const loc = Array.isArray(job.jobLocation) ? job.jobLocation[0] : job.jobLocation;
        if (loc && loc.address) {
            const addr = loc.address;
            const city = addr.addressLocality || '';
            const region = addr.addressRegion || '';
            const country = addr.addressCountry || '';
            const parts = [city, region, country]
                .map((p) => String(p).trim())
                .filter(Boolean);
            if (parts.length) data.location = parts.join(', ');
        }
    }

    if (job.datePosted) data.date_posted = String(job.datePosted).trim();

    if (job.employmentType) {
        data.job_type = Array.isArray(job.employmentType)
            ? job.employmentType.join(', ')
            : String(job.employmentType).trim();
    }

    if (job.baseSalary) {
        const s = job.baseSalary;
        const v = s.value || {};
        const amount = v.value || v.minValue || null;
        const currency = s.currency || v.currency || null;
        const unit = s['@type'] || v['@type'] || null;
        data.salary = [amount, currency, unit].filter(Boolean).join(' ');
    }

    return data;
}

function extractJobId(url) {
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        return parts[parts.length - 1] || url;
    } catch {
        return url;
    }
}

Actor.main(async () => {
    const input = (await Actor.getInput()) || {};
    let {
        startUrl = '',
        keyword = '',
        location = '',
        category = '',
        collectDetails = true,
        dedupe = true,
        results_wanted: RESULTS_WANTED_RAW = 100,
        max_pages: MAX_PAGES_RAW = 20,
        sortByPublished = true,
        proxyConfiguration,
        cookies,
        cookiesJson,
    } = input;

    const RESULTS_WANTED = Number.isFinite(Number(RESULTS_WANTED_RAW))
        ? Math.max(1, Number(RESULTS_WANTED_RAW))
        : 100;

    const MAX_PAGES = Number.isFinite(Number(MAX_PAGES_RAW))
        ? Math.max(1, Number(MAX_PAGES_RAW))
        : 20;

    const perPage = Math.min(50, RESULTS_WANTED);

    const proxyConf = proxyConfiguration
        ? await Actor.createProxyConfiguration(proxyConfiguration)
        : undefined;

    // Apply filters from startUrl when it is a listing link.
    if (startUrl && !/\/jobs\/detail\//i.test(startUrl)) {
        try {
            const u = new URL(startUrl);
            if (u.hostname.includes('powertofly.com') && u.pathname.includes('/jobs')) {
                keyword = keyword || u.searchParams.get('keywords') || '';
                location = location || u.searchParams.get('location') || '';
                category = category || u.searchParams.get('category') || '';
            }
        } catch {
            // ignore malformed startUrl
        }
    }

    const cookieHeader = buildCookieHeader({ cookies, cookiesJson });
    const baseHeaders = { ...DEFAULT_HEADERS };
    if (cookieHeader) baseHeaders.Cookie = cookieHeader;

    const searchFilters = {
        'filters[published]': 'true',
    };
    if (keyword) searchFilters.keywords = keyword;
    if (location) searchFilters.location = location;
    if (category) searchFilters.category = category;
    if (sortByPublished) searchFilters.sort_by_published = 'True';

    const jobIds = new Set();
    let totalFromApi = null;
    let page = 1;

    // Seed with explicit job detail URL if provided.
    const seedDetailUrls = [];
    if (startUrl && /\/jobs\/detail\//i.test(startUrl)) {
        seedDetailUrls.push(startUrl);
        jobIds.add(extractJobId(startUrl));
    }

    log.info(`Search filters -> keywords: "${keyword}", location: "${location}", category: "${category}"`);

    while (page <= MAX_PAGES && jobIds.size < RESULTS_WANTED) {
        const proxyUrl = proxyConf ? await proxyConf.newUrl() : undefined;
        const searchParams = { ...searchFilters, page, per_page: perPage };

        try {
            const response = await gotScraping({
                url: SEARCH_ENDPOINT,
                searchParams,
                headers: baseHeaders,
                proxyUrl,
                timeout: { request: 20000 },
            });

            const data = JSON.parse(response.body);
            const jobs = Array.isArray(data.jobs) ? data.jobs : [];
            totalFromApi = typeof data.total === 'number' ? data.total : totalFromApi;

            const before = jobIds.size;
            for (const job of jobs) {
                if (!job || !job.id) continue;
                if (!dedupe || !jobIds.has(job.id)) jobIds.add(job.id);
            }

            const gained = jobIds.size - before;
            log.info(
                `Page ${page}: fetched ${jobs.length} rows, +${gained} new IDs (total ${jobIds.size})`
            );

            if (jobs.length === 0 || gained === 0) break;
        } catch (err) {
            log.error(`Search page ${page} failed: ${err.message}`);
            break;
        }

        if (jobIds.size >= RESULTS_WANTED) break;
        page += 1;
    }

    if (jobIds.size === 0 && seedDetailUrls.length === 0) {
        log.warning('No job IDs collected from search. Exiting.');
        return;
    }

    const detailUrls = [...new Set(seedDetailUrls.concat([...jobIds].map((id) => `${DETAIL_BASE}${id}`)))]
        .slice(0, RESULTS_WANTED);

    if (!collectDetails) {
        log.info(`collectDetails=false -> pushing ${detailUrls.length} bare results.`);
        let pushed = 0;
        for (const url of detailUrls) {
            await Dataset.pushData({
                job_id: extractJobId(url),
                url,
            });
            pushed += 1;
        }
        log.info(`Job finished. Saved ${pushed} items (details skipped).`);
        return;
    }

    let saved = 0;
    const detailCrawler = new CheerioCrawler({
        proxyConfiguration: proxyConf,
        maxConcurrency: 20,
        requestHandlerTimeoutSecs: 30,
        maxRequestRetries: 3,
        requestHandler: async ({ request, $, body }) => {
            if (saved >= RESULTS_WANTED) return;

            if (!$ && body) $ = cheerioLoad(body);
            if (!$) {
                log.warning(`Missing DOM for ${request.url}`);
                return;
            }

            const ld = parseJsonLd($) || {};
            const data = { ...ld };

            if (!data.title) {
                data.title =
                    $('h1.job-title, h1[class*="title"], .job-detail-title, h1')
                        .first()
                        .text()
                        .trim() || null;
            }

            if (!data.company) {
                data.company =
                    $('.company-name, .employer-name, .job-company, [class*="company-name"]')
                        .first()
                        .text()
                        .trim() || null;
            }

            if (!data.description_html) {
                const desc = $('.job-description, .job-details, .job-content, .description')
                    .first()
                    .html();
                data.description_html = desc ? desc.trim() : null;
            }
            data.description_text = cleanText(data.description_html);

            let loc = data.location;
            if (!loc) {
                loc =
                    $('.job-location, .job-detail-location, .location')
                        .first()
                        .text()
                        .trim() || null;
            }

            const locNorm = normalizeLocation(loc);

            if (!data.date_posted) {
                const dateEl = $('time[datetime], .posted-date, [class*="date"]').first();
                data.date_posted =
                    dateEl.attr('datetime')?.trim() || dateEl.text().trim() || null;
            }

            if (!data.job_type) {
                data.job_type =
                    $('.job-type, .employment-type')
                        .first()
                        .text()
                        .trim() || null;
            }

            if (!data.salary) {
                data.salary =
                    $('.job-salary, .compensation')
                        .first()
                        .text()
                        .trim() || null;
            }

            const item = {
                job_id: extractJobId(request.url),
                url: request.url,
                title: data.title || null,
                company: data.company || null,
                location: locNorm.location,
                is_remote: locNorm.is_remote,
                remote_type: locNorm.remote_type,
                region: locNorm.region,
                salary: data.salary || null,
                job_type: data.job_type || null,
                date_posted: data.date_posted || null,
                description_html: data.description_html || null,
                description_text: data.description_text || null,
            };

            await Dataset.pushData(item);
            saved += 1;
            log.info(`Saved ${saved}/${RESULTS_WANTED}`);
        },
    });

    log.info(`Detail scraping ${detailUrls.length} jobs (cap ${RESULTS_WANTED}).`);
    await detailCrawler.run(detailUrls.map((url) => ({ url, headers: baseHeaders })));
    log.info(`Job finished. Saved ${saved} jobs. Total available (search): ${totalFromApi ?? 'unknown'}`);
});
