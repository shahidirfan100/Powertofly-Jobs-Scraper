// PowerToFly jobs scraper - improved CheerioCrawler implementation
// - Robust pagination
// - Better job link discovery
// - Clean location fields (no location_raw, no category)
// - Production-ready, reasonably stealthy defaults

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '',
            location = '',
            category = '',        // category still accepted, but not stored
            results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 50,
            collectDetails = true, // kept for backwards compatibility
            startUrl,
            startUrls,
            url,
            proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(Number(RESULTS_WANTED_RAW))
            ? Math.max(1, Number(RESULTS_WANTED_RAW))
            : 100;

        const MAX_PAGES = Number.isFinite(Number(MAX_PAGES_RAW))
            ? Math.max(1, Number(MAX_PAGES_RAW))
            : 50;

        log.info('Actor input', {
            keyword,
            location,
            category,
            RESULTS_WANTED,
            MAX_PAGES,
            collectDetails,
        });

        // Build initial URLs
        const initial = new Set();

        if (Array.isArray(startUrls) && startUrls.length > 0) {
            for (const u of startUrls) {
                if (!u) continue;
                if (typeof u === 'string') initial.add(u);
                else if (typeof u === 'object' && typeof u.url === 'string') initial.add(u.url);
            }
        } else if (typeof startUrl === 'string' && startUrl) {
            initial.add(startUrl);
        } else if (typeof url === 'string' && url) {
            initial.add(url);
        } else {
            const params = new URLSearchParams();
            if (keyword) params.set('keywords', keyword);
            if (location) params.set('location', location);
            if (category) params.set('category', category);

            const base = 'https://powertofly.com/jobs/';
            const finalUrl = params.toString() ? `${base}?${params.toString()}` : base;
            initial.add(finalUrl);
        }

        if (initial.size === 0) throw new Error('No start URLs resolved.');

        const proxyConf = proxyConfiguration
            ? await Actor.createProxyConfiguration(proxyConfiguration)
            : undefined;

        let saved = 0;
        let pagesVisited = 0;

        // Helpers
        function toAbs(href, base) {
            if (!href) return null;
            try { return new URL(href, base).href; } catch { return null; }
        }

        function cleanText(html) {
            if (!html) return null;
            try {
                const $ = cheerioLoad(html);
                const text = $('body').length ? $('body').text() : $.root().text();
                return text.replace(/\s+/g, ' ').trim() || null;
            } catch { return null; }
        }

        // ⭐ Cleaned location helper (NO location_raw returned)
        function normalizeLocation(raw) {
            if (!raw) {
                return {
                    location: null,
                    is_remote: null,
                    remote_type: null,
                    region: null,
                };
            }

            let text = String(raw).trim().replace(/[\[\]]/g, '');

            const parts = text
                .split(/[·•|/,-]/)
                .map((p) => p.trim())
                .filter(Boolean);

            let is_remote = false;
            let remote_type = null;
            const locations = [];

            for (const p of parts) {
                if (p.toLowerCase().includes('remote')) {
                    is_remote = true;
                    if (!remote_type) remote_type = p;
                } else {
                    locations.push(p);
                }
            }

            const joined = locations.join(' / ') || null;

            return {
                location: joined,
                is_remote: is_remote || null,
                remote_type: remote_type || null,
                region: joined,
            };
        }

        function parseJsonLd($) {
            const jsonLd = [];
            $('script[type="application/ld+json"]').each((_, el) => {
                const txt = $(el).contents().text().trim();
                if (!txt) return;
                try {
                    const parsed = JSON.parse(txt);
                    Array.isArray(parsed) ? jsonLd.push(...parsed) : jsonLd.push(parsed);
                } catch {}
            });

            const flattened = jsonLd.flatMap((o) =>
                o && o['@graph'] ? o['@graph'] : [o]
            );

            const job = flattened.find((o) => {
                const t = o?.['@type'];
                if (!t) return false;
                if (Array.isArray(t)) return t.includes('JobPosting');
                return t === 'JobPosting';
            });

            if (!job) return null;

            const data = {};

            if (job.title) data.title = String(job.title).trim();
            if (job.description) data.description_html = String(job.description).trim();

            if (job.hiringOrganization?.name) {
                data.company = String(job.hiringOrganization.name).trim();
            }

            if (job.jobLocation) {
                const loc = Array.isArray(job.jobLocation)
                    ? job.jobLocation[0]
                    : job.jobLocation;
                if (loc?.address) {
                    const addr = loc.address;
                    const city = addr.addressLocality || '';
                    const region = addr.addressRegion || '';
                    const country = addr.addressCountry || '';
                    const parts = [city, region, country].filter(Boolean).map((s) => s.trim());
                    if (parts.length) data.location = parts.join(', ');
                }
            }

            if (job.datePosted) data.date_posted = job.datePosted.trim();

            if (job.employmentType) {
                data.job_type = Array.isArray(job.employmentType)
                    ? job.employmentType.join(', ')
                    : job.employmentType;
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

        // ⭐ Improved job link extraction
        function findJobLinks($, base) {
            const links = new Set();

            const selectors = [
                '.job-card',
                '[data-testid="job-card"]',
                '[class*="job-card"]',
                '.jobs-list-item',
                '.job-listing',
            ];

            $(selectors.join(',')).each((_, card) => {
                const href = $(card).find('a[href]').first().attr('href');
                const abs = toAbs(href, base);
                if (abs && /\/jobs\/detail\//i.test(abs)) links.add(abs);
            });

            $('a[href*="/jobs/"]').each((_, a) => {
                const href = $(a).attr('href');
                const abs = toAbs(href, base);
                if (abs && /\/jobs\/detail\//i.test(abs)) links.add(abs);
            });

            return [...links];
        }

        // ⭐ Robust next page discovery
        function findNextPage($, base, pageNo) {
            const rel = $('a[rel="next"]').attr('href');
            if (rel) return toAbs(rel, base);

            const patterns = ['next', 'older', 'more jobs', 'load more', '›', '»'];
            let htmlCandidate = null;

            $('a[href]').each((_, a) => {
                const txt = $(a).text().trim().toLowerCase();
                if (patterns.some((t) => txt.includes(t))) {
                    htmlCandidate = toAbs($(a).attr('href'), base);
                }
            });

            if (htmlCandidate) return htmlCandidate;

            let best = null;
            let bestPage = 0;
            $('a[href*="page="]').each((_, a) => {
                const abs = toAbs($(a).attr('href'), base);
                try {
                    const u = new URL(abs);
                    const p = Number(u.searchParams.get('page') || 0);
                    if (p > pageNo && p > bestPage) {
                        best = abs;
                        bestPage = p;
                    }
                } catch {}
            });

            return best;
        }

        // Fallback pagination
        function buildNextPageUrl(currentUrl, pageNo) {
            try {
                const u = new URL(currentUrl);
                const cur = Number(u.searchParams.get('page') || pageNo || 1);
                u.searchParams.set('page', String(cur + 1));
                return u.href;
            } catch {
                return null;
            }
        }

        function extractJobId(jobUrl) {
            try {
                const u = new URL(jobUrl);
                const parts = u.pathname.split('/').filter(Boolean);
                return parts[parts.length - 1] || jobUrl;
            } catch {
                return jobUrl;
            }
        }

        // ⭐ CRAWLER
        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxConcurrency: 20,
            maxRequestsPerCrawl: MAX_PAGES * 60,
            requestHandlerTimeoutSecs: 30,
            maxRequestRetries: 3,
            navigationTimeoutSecs: 30,

            async requestHandler(context) {
                const { request } = context;
                let { $, body } = context;
                const { label = 'LIST', pageNo = 1 } = request.userData || {};

                // -----------------------------------------------------------
                // LIST PAGE
                // -----------------------------------------------------------
                if (label === 'LIST') {
                    pagesVisited++;
                    log.info(`LIST page ${pageNo}: ${request.url}`);

                    if (!$ && body) $ = cheerioLoad(body);
                    if (!$) return;

                    const links = findJobLinks($, request.url);
                    log.info(`Found ${links.length} job links on page ${pageNo}`);

                    const remaining = RESULTS_WANTED - saved;
                    if (remaining > 0) {
                        const urls = links.slice(0, remaining).map((u) => ({
                            url: u,
                            userData: { label: 'DETAIL' },
                        }));
                        await crawler.addRequests(urls);
                        log.info(`Enqueued ${urls.length} job detail pages`);
                    }

                    // pagination
                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        const nextHtml = findNextPage($, request.url, pageNo);
                        const next = nextHtml || buildNextPageUrl(request.url, pageNo);
                        if (next) {
                            await crawler.addRequests([
                                { url: next, userData: { label: 'LIST', pageNo: pageNo + 1 } },
                            ]);
                            log.info(`Next page queued: ${next}`);
                        }
                    }

                    return;
                }

                // -----------------------------------------------------------
                // DETAIL PAGE
                // -----------------------------------------------------------
                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) return;

                    log.info(`DETAIL: ${request.url}`);

                    try {
                        if (!$ && body) $ = cheerioLoad(body);
                        if (!$) return;

                        const data = {};

                        const ld = parseJsonLd($) || {};
                        Object.assign(data, ld);

                        if (!data.title) {
                            data.title = $('h1.job-title, h1, [class*="title"]')
                                .first()
                                .text()
                                .trim() || null;
                        }

                        if (!data.company) {
                            data.company = $('.company-name, .employer-name, .job-company')
                                .first()
                                .text()
                                .trim() || null;
                        }

                        if (!data.description_html) {
                            const desc = $('.job-description, .job-details, .description, .job-content')
                                .first();
                            data.description_html = desc.html()?.trim() || null;
                        }

                        data.description_text = cleanText(data.description_html);

                        if (!data.location) {
                            data.location = $('.job-location, .location')
                                .first()
                                .text()
                                .trim() || null;
                        }

                        if (!data.date_posted) {
                            const el = $('time[datetime], .posted-date, [class*="date"]').first();
                            data.date_posted = el.attr('datetime')?.trim() || el.text().trim() || null;
                        }

                        if (!data.job_type) {
                            data.job_type =
                                $('.job-type, .employment-type').first().text().trim() ||
                                data.job_type ||
                                null;
                        }

                        if (!data.salary) {
                            data.salary = $('.salary, .compensation')
                                .first()
                                .text()
                                .trim() || data.salary || null;
                        }

                        const loc = normalizeLocation(data.location);

                        // ⭐ FINAL ITEM (NO location_raw, NO category)
                        const item = {
                            job_id: extractJobId(request.url),
                            url: request.url,

                            title: data.title || null,
                            company: data.company || null,

                            location: loc.location,
                            is_remote: loc.is_remote,
                            remote_type: loc.remote_type,
                            region: loc.region,

                            salary: data.salary || null,
                            job_type: data.job_type || null,
                            date_posted: data.date_posted || null,

                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                        };

                        await Dataset.pushData(item);
                        saved++;
                        log.info(`Saved job ${saved}/${RESULTS_WANTED}`);
                    } catch (err) {
                        log.error(`DETAIL FAILED: ${request.url} -> ${err.message}`);
                    }
                }
            },
        });

        await crawler.run(
            [...initial].map((u) => ({
                url: u,
                userData: { label: 'LIST', pageNo: 1 },
            })),
        );

        log.info(`Finished. Saved ${saved} items. Pages visited: ${pagesVisited}`);
    } finally {
        await Actor.exit();
    }
}

main();
