# PowerToFly Jobs Scraper

Extract comprehensive job listings from PowerToFly - one of the leading platforms for diverse talent recruitment. This scraper efficiently collects job postings with complete details including titles, companies, locations, salaries, job types, and full descriptions.

## What does the PowerToFly Jobs Scraper do?

The PowerToFly Jobs Scraper automatically extracts job listings from [PowerToFly.com](https://powertofly.com/jobs/), delivering structured data ready for analysis, job aggregation platforms, or recruitment workflows. The scraper handles pagination, extracts detailed information from individual job pages, and outputs clean, consistent data.

### Key features:

- **API-first listings** - Uses PowerToFly's search API to pull IDs fast and reliably, bypassing infinite scroll
- **Comprehensive data extraction** - Captures titles, company, locations, salary, job type, posted date, and full descriptions
- **Flexible search options** - Filter by keywords, location, category, sort order, or start from a specific URL
- **Configurable limits & dedupe** - Cap pages/results, de-duplicate by job ID, and optionally skip detail visits
- **Proxy & cookies ready** - Works with Apify proxies and optional custom cookies for hard targets
- **Structured output** - Clean, normalized JSON via Apify dataset with HTML + text descriptions

## How much does it cost to scrape PowerToFly jobs?

The cost depends on the number of jobs extracted and whether you enable detailed scraping. Typical runs are efficient and cost-effective:

- **10 jobs with details**: ~$0.01-0.02
- **100 jobs with details**: ~$0.05-0.10
- **500 jobs with details**: ~$0.25-0.50

Costs may vary based on proxy usage and extraction depth. Using Apify's residential proxies provides the most reliable results.

## Input configuration

Configure your scraping job with these parameters:

### Search parameters

| Field | Type | Description | Required |
|-------|------|-------------|----------|
| `keyword` | String | Job search keywords (e.g., "Software Engineer", "Data Scientist") | No |
| `location` | String | Filter by location (e.g., "Remote", "New York", "San Francisco") | No |
| `category` | String | Filter by job category or industry | No |
| `startUrl` | String | Direct PowerToFly URL to start scraping (detail URL seeds a single job, listing URL seeds filters) | No |
| `sortByPublished` | Boolean | When true, newest published jobs first | No |

### Extraction settings

| Field | Type | Description | Default |
|-------|------|-------------|---------|
| `collectDetails` | Boolean | Visit each job page to extract full details | `true` |
| `dedupe` | Boolean | Remove duplicate job IDs before saving | `true` |
| `results_wanted` | Integer | Maximum number of jobs to extract | `100` |
| `max_pages` | Integer | Maximum number of listing pages (API pages) to crawl | `20` |

### Advanced options

| Field | Type | Description |
|-------|------|-------------|
| `proxyConfiguration` | Object | Proxy settings (residential proxies recommended) |
| `cookies` | String | Custom cookies as raw header string |
| `cookiesJson` | String | Custom cookies in JSON format |

## Sample input

```json
{
  "keyword": "software engineer",
  "location": "Remote",
  "results_wanted": 50,
  "max_pages": 5,
  "collectDetails": true,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

## Output format

Each job listing is exported as a structured JSON object with the following fields:

```json
{
  "title": "Senior Software Engineer",
  "company": "Tech Company Inc.",
  "category": "Technology",
  "location": "Remote, United States",
  "salary": "$120,000 - $180,000",
  "job_type": "Full-time",
  "date_posted": "2025-11-28",
  "description_html": "<p>We are seeking an experienced software engineer...</p>",
  "description_text": "We are seeking an experienced software engineer...",
  "url": "https://powertofly.com/jobs/detail/12345"
}
```

### Output fields explained

- **title** - Job position title
- **company** - Hiring company name
- **category** - Job category or industry
- **location** - Work location (can include "Remote", "Hybrid", or specific cities)
- **salary** - Compensation range when available
- **job_type** - Employment type (Full-time, Part-time, Contract, etc.)
- **date_posted** - When the job was posted
- **description_html** - Full job description in HTML format
- **description_text** - Plain text version of the description
- **url** - Direct link to the job posting

## Use cases

### Job aggregation platforms
Build comprehensive job boards by regularly scraping PowerToFly listings and combining them with other sources.

### Recruitment analytics
Analyze hiring trends, salary ranges, and in-demand skills across different industries and locations.

### Automated job alerts
Create personalized job alert systems by monitoring new postings matching specific criteria.

### Market research
Research competitive compensation, job requirements, and hiring patterns in specific industries or regions.

### Career planning
Track job market trends, required skills, and career opportunities in your field of interest.

## Tips for optimal results

### Search strategy
- Use specific keywords for targeted results (e.g., "Machine Learning Engineer" vs "Engineer")
- Combine keywords with location filters for regional job searches
- Leave location empty to search globally across all PowerToFly listings

### Performance optimization
- Set reasonable `results_wanted` limits to control costs and runtime
- Use `max_pages` to cap the number of pages crawled
- Enable `collectDetails` only when you need full job descriptions
- Enable `dedupe` to automatically remove duplicate listings

### Reliability
- Always use proxy configuration for reliable access
- Residential proxies provide the best success rates
- If you encounter issues, try providing custom cookies

## Integration and export

The scraper outputs data to an Apify dataset, which can be:

- **Exported** to JSON, CSV, Excel, or XML formats
- **Accessed** via Apify API for programmatic integration
- **Pushed** to webhooks, databases, or cloud storage
- **Connected** to other Apify actors for data processing pipelines

## Rate limits and best practices

PowerToFly implements standard rate limiting and anti-bot measures. This scraper is designed to respect these limits while maintaining reliable extraction:

- Requests are automatically throttled to avoid overwhelming the server
- Proxy rotation helps distribute requests across multiple IP addresses
- Failed requests are retried automatically with exponential backoff
- Session management maintains consistent behavior across requests

## Legal and ethical considerations

This scraper is provided for legitimate use cases such as job search, market research, and recruitment analytics. Users are responsible for:

- Complying with PowerToFly's Terms of Service
- Respecting data privacy and applicable regulations (GDPR, CCPA, etc.)
- Using extracted data responsibly and ethically
- Not overwhelming PowerToFly's servers with excessive requests

Always review and comply with the target website's robots.txt file and terms of service.

## Support

Need help or have questions?

- Check the [Apify documentation](https://docs.apify.com)
- Explore example runs and outputs in the actor's detail page
- Review the input schema for detailed parameter descriptions

## Changelog

### Version 1.0.0
- Initial release with PowerToFly support
- Complete job data extraction including salary and job type
- Flexible search by keyword, location, and category
- Configurable pagination and result limits
- JSON-LD structured data parsing with HTML fallback
