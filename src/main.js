// PowerToFly jobs scraper - CheerioCrawler implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '', location = '', category = '', results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 999, collectDetails = true, startUrl, startUrls, url, proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

        const toAbs = (href, base = 'https://powertofly.com') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const buildStartUrl = (kw, loc, cat) => {
            const u = new URL('https://powertofly.com/jobs/');
            const params = new URLSearchParams();
            if (kw) params.set('keywords', String(kw).trim());
            if (loc) params.set('location', String(loc).trim());
            if (cat) params.set('category', String(cat).trim());
            const paramStr = params.toString();
            return paramStr ? `${u.href}?${paramStr}` : u.href;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(keyword, location, category));

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;

        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    for (const e of arr) {
                        if (!e) continue;
                        const t = e['@type'] || e.type;
                        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
                            return {
                                title: e.title || e.name || null,
                                company: e.hiringOrganization?.name || null,
                                date_posted: e.datePosted || null,
                                description_html: e.description || null,
                                location: (e.jobLocation && e.jobLocation.address && (e.jobLocation.address.addressLocality || e.jobLocation.address.addressRegion)) || null,
                                salary: e.baseSalary ? (typeof e.baseSalary === 'string' ? e.baseSalary : JSON.stringify(e.baseSalary)) : null,
                                job_type: e.employmentType || null,
                            };
                        }
                    }
                } catch (e) { /* ignore parsing errors */ }
            }
            return null;
        }

        function findJobLinks($, base) {
            const links = new Set();
            // PowerToFly uses specific job URL patterns
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                // Match PowerToFly job URLs (typically /jobs/detail/...)
                if (/\/jobs\/detail\//i.test(href) || /powertofly\.com\/jobs/i.test(href)) {
                    const abs = toAbs(href, base);
                    if (abs && !abs.includes('/jobs/?') && !abs.includes('/jobs/#')) links.add(abs);
                }
            });
            return [...links];
        }

        function findNextPage($, base) {
            // PowerToFly pagination - look for next page button or link
            const rel = $('a[rel="next"]').attr('href');
            if (rel) return toAbs(rel, base);
            
            // Look for pagination links
            const nextBtn = $('a.pagination-next, a[aria-label*="next" i], button.pagination-next').attr('href');
            if (nextBtn) return toAbs(nextBtn, base);
            
            const next = $('a').filter((_, el) => {
                const text = $(el).text().trim().toLowerCase();
                return text === 'next' || text === '›' || text === '»' || text === '>';
            }).first().attr('href');
            if (next) return toAbs(next, base);
            
            return null;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            useSessionPool: true,
            maxConcurrency: 10,
            requestHandlerTimeoutSecs: 60,
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                if (label === 'LIST') {
                    const links = findJobLinks($, request.url);
                    crawlerLog.info(`LIST ${request.url} -> found ${links.length} links`);

                    if (collectDetails) {
                        const remaining = RESULTS_WANTED - saved;
                        const toEnqueue = links.slice(0, Math.max(0, remaining));
                        if (toEnqueue.length) await enqueueLinks({ urls: toEnqueue, userData: { label: 'DETAIL' } });
                    } else {
                        const remaining = RESULTS_WANTED - saved;
                        const toPush = links.slice(0, Math.max(0, remaining));
                        if (toPush.length) { await Dataset.pushData(toPush.map(u => ({ url: u, _source: 'powertofly.com' }))); saved += toPush.length; }
                    }

                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        const next = findNextPage($, request.url);
                        if (next) await enqueueLinks({ urls: [next], userData: { label: 'LIST', pageNo: pageNo + 1 } });
                    }
                    return;
                }

                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) return;
                    try {
                        const json = extractFromJsonLd($);
                        const data = json || {};
                        
                        // PowerToFly specific selectors
                        if (!data.title) {
                            data.title = $('h1.job-title, h1[class*="title"], .job-detail-title, h1').first().text().trim() || null;
                        }
                        
                        if (!data.company) {
                            data.company = $('.company-name, [class*="company"], .employer-name, .job-company').first().text().trim() || null;
                        }
                        
                        if (!data.description_html) {
                            const desc = $('.job-description, [class*="description"], .job-details, .job-content, .description').first();
                            data.description_html = desc && desc.length ? String(desc.html()).trim() : null;
                        }
                        data.description_text = data.description_html ? cleanText(data.description_html) : null;
                        
                        if (!data.location) {
                            data.location = $('.job-location, [class*="location"], .location, [class*="job-address"]').first().text().trim() || null;
                        }
                        
                        if (!data.salary) {
                            data.salary = $('.salary, [class*="salary"], .compensation, [class*="compensation"]').first().text().trim() || null;
                        }
                        
                        if (!data.job_type) {
                            data.job_type = $('.job-type, [class*="job-type"], .employment-type, [class*="employment"]').first().text().trim() || null;
                        }
                        
                        if (!data.date_posted) {
                            const dateText = $('.posted-date, [class*="posted"], .date-posted, time').first().text().trim();
                            data.date_posted = dateText || null;
                        }

                        const item = {
                            title: data.title || null,
                            company: data.company || null,
                            category: category || null,
                            location: data.location || null,
                            salary: data.salary || null,
                            job_type: data.job_type || null,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: request.url,
                        };

                        await Dataset.pushData(item);
                        saved++;
                    } catch (err) { crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`); }
                }
            }
        });

        await crawler.run(initial.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
        log.info(`Finished. Saved ${saved} items`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
