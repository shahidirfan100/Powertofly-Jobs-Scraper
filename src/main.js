// PowerToFly jobs scraper - improved CheerioCrawler implementation
// - Robust pagination
// - Better job link discovery
// - Clean location fields (no more "Remote · Worldwide" in a single column)
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
            category = '',
            results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 50,
            collectDetails = true, // kept for backwards-compat (currently always collects details)
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

        // 1) Explicit URLs win
        if (Array.isArray(startUrls) && startUrls.length > 0) {
            for (const u of startUrls) {
                if (!u) continue;
                if (typeof u === 'string') {
                    initial.add(u);
                } else if (typeof u === 'object' && typeof u.url === 'string') {
                    initial.add(u.url);
                }
            }
        } else if (typeof startUrl === 'string' && startUrl) {
            initial.add(startUrl);
        } else if (typeof url === 'string' && url) {
            initial.add(url);
        } else {
            // 2) Default PowerToFly job listing with simple filters
            const params = new URLSearchParams();
            if (keyword) params.set('keywords', keyword);
            if (location) params.set('location', location);
            if (category) params.set('category', category);

            const base = 'https://powertofly.com/jobs/';
            const finalUrl = params.toString() ? `${base}?${params.toString()}` : base;
            initial.add(finalUrl);
        }

        if (initial.size === 0) {
            throw new Error('No start URLs resolved. Provide "startUrls", "startUrl", or "url" in input.');
        }

        const proxyConf = proxyConfiguration
            ? await Actor.createProxyConfiguration(proxyConfiguration)
            : undefined;

        let saved = 0;
        let pagesVisited = 0;

        // Helper: make absolute URL
        function toAbs(href, base) {
            if (!href) return null;
            try {
                return new URL(href, base).href;
            } catch {
                return null;
            }
        }

        // Helper: clean HTML to plain text
        function cleanText(html) {
            if (!html) return null;
            try {
                const $ = cheerioLoad(html);
                const text = $('body').length ? $('body').text() : $.root().text();
                return text.replace(/\s+/g, ' ').trim() || null;
            } catch {
                return null;
            }
        }

        // Helper: normalize location string
        function normalizeLocation(raw) {
            if (!raw) {
                return {
                    location: null,
                    location_raw: null,
                    is_remote: null,
                    remote_type: null,
                    region: null,
                };
            }

            let text = String(raw).trim();
            // Remove brackets or weird wrapping
            text = text.replace(/[\[\]]/g, '');

            // Split on common separators
            const parts = text
                .split(/[·•|/,-]/)
                .map((p) => p.trim())
                .filter(Boolean);

            let is_remote = false;
            let remote_type = null;
            const locations = [];

            for (const p of parts) {
                const lower = p.toLowerCase();
                if (lower.includes('remote')) {
                    is_remote = true;
                    // Keep the first remote descriptor
                    if (!remote_type) remote_type = p;
                } else {
                    locations.push(p);
                }
            }

            const joinedLocations = locations.join(' / ') || null;

            return {
                location: joinedLocations,
                location_raw: text,
                is_remote: is_remote || null,
                remote_type: remote_type || null,
                region: joinedLocations,
            };
        }

        // Helper: extract JSON-LD jobPosting
        function parseJsonLd($) {
            const jsonLd = [];
            $('script[type="application/ld+json"]').each((_, el) => {
                const txt = $(el).contents().text().trim();
                if (!txt) return;
                try {
                    const parsed = JSON.parse(txt);
                    if (Array.isArray(parsed)) {
                        jsonLd.push(...parsed);
                    } else {
                        jsonLd.push(parsed);
                    }
                } catch {
                    // ignore JSON parse errors
                }
            });

            const flattened = jsonLd.flatMap((obj) => {
                if (!obj) return [];
                if (obj['@graph'] && Array.isArray(obj['@graph'])) return obj['@graph'];
                return [obj];
            });

            const job = flattened.find((obj) => {
                const type = obj['@type'];
                if (!type) return false;
                if (Array.isArray(type)) return type.includes('JobPosting');
                return type === 'JobPosting';
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
                    const parts = [city, region, country].map((p) => String(p).trim()).filter(Boolean);
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
                const value = s.value || {};
                const amount = value.value || value.minValue || null;
                const currency = s.currency || value.currency || null;
                const unit = s['@type'] || value['@type'] || null;
                data.salary = [amount, currency, unit].filter(Boolean).join(' ');
            }

            return data;
        }

        // Helper: robust job link discovery
        function findJobLinks($, base) {
            const links = new Set();

            // 1) Job card based discovery (preferred)
            const jobCardSelectors = [
                '.job-card',
                '[data-testid="job-card"]',
                '[class*="job-card"]',
                '.jobs-list-item',
                '.job-listing',
            ];

            $(jobCardSelectors.join(',')).each((_, card) => {
                const $card = $(card);
                const anchor = $card.find('a[href]').first();
                const href = anchor.attr('href');
                if (!href) return;
                const abs = toAbs(href, base);
                if (abs && /\/jobs\/detail\//i.test(abs)) {
                    links.add(abs);
                }
            });

            // 2) Fallback: any /jobs/detail/ links in the page
            $('a[href*="/jobs/"]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                const abs = toAbs(href, base);
                if (!abs) return;
                if (/\/jobs\/detail\//i.test(abs)) {
                    links.add(abs);
                }
            });

            return [...links];
        }

        // Helper: extract NEXT page URL from HTML
        function findNextPage($, base, pageNo) {
            // 1) Explicit rel="next"
            const rel = $('a[rel="next"]').attr('href');
            if (rel) {
                return toAbs(rel, base);
            }

            // 2) Look for links with text like "Next", "›", "»"
            const candidates = [];
            $('a[href]').each((_, a) => {
                const $a = $(a);
                const text = $a.text().trim().toLowerCase();
                if (!text) return;
                if (['next', 'older', 'more jobs', 'load more', '›', '»'].some((t) => text.includes(t))) {
                    const href = $a.attr('href');
                    const abs = toAbs(href, base);
                    if (abs) candidates.push(abs);
                }
            });
            if (candidates.length > 0) return candidates[0];

            // 3) Look for explicit ?page= links with higher page number
            let best = null;
            let bestPage = 0;

            $('a[href*="page="]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                const abs = toAbs(href, base);
                if (!abs) return;
                try {
                    const u = new URL(abs);
                    const p = Number(u.searchParams.get('page') || 0);
                    if (Number.isFinite(p) && p > pageNo && p > bestPage) {
                        bestPage = p;
                        best = u.href;
                    }
                } catch {
                    // ignore
                }
            });

            if (best) return best;

            return null;
        }

        // Helper: fallback pagination by editing URL ?page=
        function buildNextPageUrl(currentUrl, pageNo) {
            try {
                const u = new URL(currentUrl);
                const current = Number(u.searchParams.get('page') || pageNo || 1);
                const nextPage = current + 1;
                u.searchParams.set('page', String(nextPage));
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

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxConcurrency: 20,
            maxRequestsPerCrawl: MAX_PAGES * 60, // assume <= 60 jobs/page by default
            requestHandlerTimeoutSecs: 30,
            maxRequestRetries: 3,
            navigationTimeoutSecs: 30,
            async requestHandler(context) {
                const { request } = context;
                let { $, body } = context;
                const { label = 'LIST', pageNo = 1 } = request.userData || {};

                if (label === 'LIST') {
                    pagesVisited += 1;
                    log.info(`LIST page ${pageNo}: ${request.url}`);

                    if (!$ && body) {
                        $ = cheerioLoad(body);
                    }

                    if (!$) {
                        log.warning(`No DOM for LIST page: ${request.url}`);
                        return;
                    }

                    // Discover job links
                    const links = findJobLinks($, request.url);
                    log.info(`Found ${links.length} job links on page ${pageNo}`);

                    const remaining = RESULTS_WANTED - saved;
                    if (remaining <= 0) {
                        log.info('Desired results already saved, skipping job enqueue.');
                    } else {
                        const toEnqueueUrls = links.slice(0, Math.max(0, remaining));
                        if (toEnqueueUrls.length) {
                            await crawler.addRequests(
                                toEnqueueUrls.map((link) => ({
                                    url: link,
                                    userData: { label: 'DETAIL' },
                                })),
                            );
                        }
                        log.info(`Enqueued ${toEnqueueUrls.length} DETAIL requests from page ${pageNo}`);
                    }

                    // Pagination – only if we still want more results and haven't hit page limit
                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        const nextHtml = findNextPage($, request.url, pageNo);
                        const nextUrl = nextHtml || buildNextPageUrl(request.url, pageNo);
                        if (nextUrl) {
                            await crawler.addRequests([
                                {
                                    url: nextUrl,
                                    userData: { label: 'LIST', pageNo: pageNo + 1 },
                                },
                            ]);
                            log.info(`Enqueued LIST page ${pageNo + 1}: ${nextUrl}`);
                        } else {
                            log.info(`No next page found after page ${pageNo}`);
                        }
                    } else if (pageNo >= MAX_PAGES) {
                        log.info(`Reached MAX_PAGES (${MAX_PAGES}), not paginating further.`);
                    }
                } else if (label === 'DETAIL') {
                    // Skip if we already met quota
                    if (saved >= RESULTS_WANTED) {
                        log.debug(`Skipping DETAIL (quota reached): ${request.url}`);
                        return;
                    }

                    log.info(`DETAIL: ${request.url}`);

                    try {
                        if (!$ && body) {
                            $ = cheerioLoad(body);
                        }
                        if (!$) {
                            log.warning(`No DOM for DETAIL page: ${request.url}`);
                            return;
                        }

                        const data = {};

                        // 1) JSON-LD
                        const ld = parseJsonLd($) || {};
                        Object.assign(data, ld);

                        // 2) DOM fallbacks
                        if (!data.title) {
                            data.title = $('h1.job-title, h1[class*="title"], .job-detail-title, h1')
                                .first()
                                .text()
                                .trim() || null;
                        }

                        if (!data.company) {
                            data.company = $('.company-name, [class*="company-name"], .employer-name, .job-company')
                                .first()
                                .text()
                                .trim() || null;
                        }

                        if (!data.description_html) {
                            const desc = $('.job-description, [class*="job-description"], .job-details, .job-content, .description')
                                .first();
                            data.description_html = desc && desc.length ? String(desc.html()).trim() : null;
                        }
                        data.description_text = data.description_html ? cleanText(data.description_html) : null;

                        if (!data.location) {
                            const locEl = $('.job-location, [class*="job-location"], .job-detail-location, .location')
                                .first();
                            const locText = locEl.length ? locEl.text().trim() : null;
                            data.location = locText || null;
                        }

                        if (!data.date_posted) {
                            const dateEl = $('.job-date, [class*="date-posted"], time[datetime], .posted-date').first();
                            if (dateEl.is('time') && dateEl.attr('datetime')) {
                                data.date_posted = dateEl.attr('datetime').trim();
                            } else {
                                const t = dateEl.text().trim();
                                if (t) data.date_posted = t;
                            }
                        }

                        if (!data.job_type) {
                            const jt = $('.job-type, [class*="job-type"], .employment-type')
                                .first()
                                .text()
                                .trim();
                            data.job_type = jt || data.job_type || null;
                        }

                        if (!data.salary) {
                            const sal = $('.job-salary, [class*="salary"], .compensation')
                                .first()
                                .text()
                                .trim();
                            data.salary = sal || data.salary || null;
                        }

                        // Normalize location fields
                        const locationNorm = normalizeLocation(data.location);

                        const item = {
                            job_id: extractJobId(request.url),
                            url: request.url,

                            title: data.title || null,
                            company: data.company || null,
                            category: category || null,

                            location: locationNorm.location,
                            location_raw: locationNorm.location_raw,
                            is_remote: locationNorm.is_remote,
                            remote_type: locationNorm.remote_type,
                            region: locationNorm.region,

                            salary: data.salary || null,
                            job_type: data.job_type || null,
                            date_posted: data.date_posted || null,

                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                        };

                        await Dataset.pushData(item);
                        saved += 1;
                        log.info(`Saved job ${saved}/${RESULTS_WANTED}`);
                    } catch (err) {
                        log.error(`DETAIL ${request.url} failed: ${err.message}`);
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

        log.info(`Finished. Saved ${saved} items from ${pagesVisited} listing pages.`);
    } finally {
        await Actor.exit();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
