import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';
import { load as cheerioLoad } from 'cheerio';

Actor.main(async () => {
    const input = (await Actor.getInput()) || {};
    const {
        keyword = '',
        location = '',
        category = '',         // only used for listing filtering, not stored
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

    // ------- PHASE 1: Listing via gotScraping -------
    let page = 1;

    while (page <= MAX_PAGES && jobLinks.size < RESULTS_WANTED) {
        const params = new URLSearchParams(baseParams.toString());
        params.set('only_html', 'True');      // Magic parameter that forces backend to return full HTML
        params.set('page', String(page));
        params.set('sort_by_published', sortByPublished ? 'True' : 'False');

        const pageUrl = `https://powertofly.com/jobs/?${params.toString()}`;
        log.info(`Fetching listing page ${page}: ${pageUrl}`);

        let html;
        try {
            const response = await gotScraping({
                url: pageUrl,
                proxyUrl: proxyConf ? proxyConf.newUrl() : undefined,
                timeout: { request: 30000 },
            });
            html = response.body;
        } catch (err) {
            log.error(`Failed to fetch page ${page}: ${err.message}`);
            break;
        }

        const $ = cheerioLoad(html);

        const before = jobLinks.size;

        // Primary job-card selectors
        $('.job-card, [data-testid="job-card"], [class*="job-card"], .jobs-list-item, .job-listing')
            .each((_, el) => {
                const href = $(el).find('a[href*="/jobs/"]').first().attr('href');
                if (!href) return;
                try {
                    const abs = new URL(href, 'https://powertofly.com').href;
                    if (/\/jobs\/\d+/i.test(abs)) jobLinks.add(abs);
                } catch {}
            });

        // Fallback selector
        $('a[href*="/jobs/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            try {
                const abs = new URL(href, 'https://powertofly.com').href;
                if (/\/jobs\/\d+/i.test(abs)) jobLinks.add(abs);
            } catch {}
        });

        const after = jobLinks.size;
        const gained = after - before;

        log.info(`Page ${page}: +${gained} jobs → total ${after}`);

        if (gained === 0) {
            log.info(`No new jobs on page ${page}. Stopping pagination.`);
            break;
        }

        if (after >= RESULTS_WANTED) break;

        page++;
    }

    if (jobLinks.size === 0) {
        log.warning("No job links found from listing pages.");
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
        const parts = text.split(/[·•|/,-]/).map(p => p.trim()).filter(Boolean);

        let isRemote = false;
        let remoteType = null;
        const locations = [];

        for (const p of parts) {
            if (p.toLowerCase().includes('remote')) {
                isRemote = true;
                if (!remoteType) remoteType = p;
            } else locations.push(p);
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
            } catch {}
        });

        const flattened = raw.flatMap(o => (o['@graph'] ? o['@graph'] : [o]));

        return flattened.find(o =>
            (Array.isArray(o['@type']) && o['@type'].includes('JobPosting')) ||
            o['@type'] === 'JobPosting'
        ) || null;
    }

    function extractJobId(url) {
        try {
            const u = new URL(url);
            const parts = u.pathname.split('/').filter(Boolean);
            return parts.at(-1) || url;
        } catch {
            return url;
        }
    }

    // ------- PHASE 2: Fast Detail Scraping via CheerioCrawler -------
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

            // Fallback title
            data.title = data.title ||
                $('h1.job-title, h1[class*="title"], .job-detail-title, h1').first().text().trim() ||
                null;

            // Fallback company
            data.company = data.company ||
                $('.company-name, .employer-name, .job-company, [class*="company-name"]')
                    .first()
                    .text()
                    .trim() ||
                null;

            // Description
            const desc = $('.job-description, .job-details, .job-content, .description')
                .first()
                .html();
            data.description_html = data.description_html || (desc ? desc.trim() : null);
            data.description_text = cleanText(data.description_html);

            // Location
            let loc = data.location;
            if (!loc) {
                loc = $('.job-location, .job-detail-location, .location')
                    .first()
                    .text()
                    .trim() || null;
            }

            const locNorm = normalizeLocation(loc);

            // Date posted
            if (!data.date_posted) {
                const dateEl = $('time[datetime], .posted-date, [class*="date"]').first();
                data.date_posted = dateEl.attr('datetime')?.trim() || dateEl.text().trim() || null;
            }

            // Job type
            if (!data.job_type) {
                data.job_type =
                    $('.job-type, .employment-type').first().text().trim() || null;
            }

            // Salary
            if (!data.salary) {
                data.salary =
                    $('.job-salary, .compensation').first().text().trim() || null;
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
            saved++;
            log.info(`Saved ${saved}/${RESULTS_WANTED}`);
        },
    });

    await detailCrawler.run(
        detailUrls.map(url => ({ url }))
    );

    log.info(`Job done. Successfully saved ${saved} jobs.`);
});
