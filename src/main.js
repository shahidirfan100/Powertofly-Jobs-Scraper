import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';
import { load as cheerioLoad } from 'cheerio';

Actor.main(async () => {
    const input = (await Actor.getInput()) || {};
    const {
        keyword = '',
        location = '',
        category = '',         // used only as filter on listing, NOT stored
        results_wanted: RESULTS_WANTED_RAW = 100,
        max_pages: MAX_PAGES_RAW = 50,
        sortByPublished = true,
        proxyConfiguration,
    } = input;

    const RESULTS_WANTED = Number.isFinite(Number(RESULTS_WANTED_RAW))
        ? Math.max(1, Number(RESULTS_WANTED_RAW))
        : 100;

    const MAX_PAGES = Number.isFinite(Number(MAX_PAGES_RAW))
        ? Math.max(1, Number(MAX_PAGES_RAW))
        : 50;

    const proxyConf = proxyConfiguration
        ? await Actor.createProxyConfiguration(proxyConfiguration)
        : undefined;

    // ------- Build Base Listing URL -------
    const baseParams = new URLSearchParams();
    if (keyword) baseParams.set('keywords', keyword);
    if (location) baseParams.set('location', location);
    if (category) baseParams.set('category', category);

    const baseUrl = `https://powertofly.com/jobs/?${baseParams.toString()}`;
    log.info(`Base listing URL: ${baseUrl}`);

    const jobLinks = new Set();
    let page = 1;

    // ------- PHASE 1: Listing via gotScraping -------
    while (page <= MAX_PAGES && jobLinks.size < RESULTS_WANTED) {
        const params = new URLSearchParams(baseParams.toString());
        params.set('only_html', 'True'); // Force backend-rendered HTML
        params.set('page', String(page));
        params.set('sort_by_published', sortByPublished ? 'True' : 'False');

        const pageUrl = `https://powertofly.com/jobs/?${params.toString()}`;
        log.info(`Fetching listing page ${page}: ${pageUrl}`);

        const proxyUrl = proxyConf ? await proxyConf.newUrl() : undefined;

        let html;
        try {
            const response = await gotScraping({
                url: pageUrl,
                proxyUrl,                   // must be string | undefined
                timeout: { request: 30000 },
            });
            html = response.body;
        } catch (err) {
            log.error(`Failed to fetch page ${page}: ${err.message}`);
            break;
        }

        const $ = cheerioLoad(html);

        const before = jobLinks.size;

        // Primary selectors: they often don't have nice classes in only_html pages,
        // so we rely heavily on the href pattern.
        $('.job-card, [data-testid="job-card"], [class*="job-card"], .jobs-list-item, .job-listing')
            .each((_, el) => {
                const href = $(el).find('a[href*="/jobs/"]').first().attr('href');
                if (!href) return;
                try {
                    const abs = new URL(href, 'https://powertofly.com').href;
                    // 🔧 FIX: match /jobs/detail/... instead of /jobs/\d+
                    if (/\/jobs\/detail\//i.test(abs)) {
                        jobLinks.add(abs);
                    }
                } catch {
                    // ignore bad URLs
                }
            });

        // Fallback: ANY <a> that looks like a job detail link
        $('a[href*="/jobs/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            try {
                const abs = new URL(href, 'https://powertofly.com').href;
                // 🔧 FIX: same here — look for /jobs/detail/
                if (/\/jobs\/detail\//i.test(abs)) {
                    jobLinks.add(abs);
                }
            } catch {
                // ignore
            }
        });

        const after = jobLinks.size;
        const gained = after - before;

        log.info(`Page ${page}: +${gained} job links → total ${after}`);

        if (gained === 0) {
            log.info(`No new jobs on page ${page}. Stopping pagination.`);
            break;
        }

        if (after >= RESULTS_WANTED) break;

        page += 1;
    }

    if (jobLinks.size === 0) {
        log.warning('No job links found from listing pages. Exiting.');
        return;
    }

    const detailUrls = Array.from(jobLinks).slice(0, RESULTS_WANTED);
    log.info(`Collected ${detailUrls.length} job URLs. Proceeding to detail scraping.`);

    // ------- Helper Functions -------
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
        const parts = text.split(/[·•|/,-]/).map((p) => p.trim()).filter(Boolean);

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

    // ------- PHASE 2: Detail Scraping via CheerioCrawler -------
    let saved = 0;

    const detailCrawler = new CheerioCrawler({
        proxyConfiguration: proxyConf,
        maxConcurrency: 20,
        requestHandlerTimeoutSecs: 30,
        maxRequestRetries: 3,

        async requestHandler({ request, $, body }) {
            if (saved >= RESULTS_WANTED) return;

            log.info(`DETAIL: ${request.url}`);

            if (!$ && body) $ = cheerioLoad(body);
            if (!$) {
                log.warning(`Missing DOM for ${request.url}`);
                return;
            }

            const ld = parseJsonLd($) || {};
            const data = { ...ld };

            // Title
            if (!data.title) {
                data.title =
                    $('h1.job-title, h1[class*="title"], .job-detail-title, h1')
                        .first()
                        .text()
                        .trim() || null;
            }

            // Company
            if (!data.company) {
                data.company =
                    $('.company-name, .employer-name, .job-company, [class*="company-name"]')
                        .first()
                        .text()
                        .trim() || null;
            }

            // Description
            if (!data.description_html) {
                const desc = $('.job-description, .job-details, .job-content, .description')
                    .first()
                    .html();
                data.description_html = desc ? desc.trim() : null;
            }
            data.description_text = cleanText(data.description_html);

            // Location
            let loc = data.location;
            if (!loc) {
                loc =
                    $('.job-location, .job-detail-location, .location')
                        .first()
                        .text()
                        .trim() || null;
            }

            const locNorm = normalizeLocation(loc);

            // Date posted
            if (!data.date_posted) {
                const dateEl = $('time[datetime], .posted-date, [class*="date"]').first();
                data.date_posted =
                    dateEl.attr('datetime')?.trim() || dateEl.text().trim() || null;
            }

            // Job type
            if (!data.job_type) {
                data.job_type =
                    $('.job-type, .employment-type')
                        .first()
                        .text()
                        .trim() || null;
            }

            // Salary
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

    await detailCrawler.run(
        detailUrls.map((url) => ({ url }))
    );

    log.info(`Job finished. Saved ${saved} jobs.`);
});
