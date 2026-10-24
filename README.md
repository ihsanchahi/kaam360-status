# Kaam360 status

The public status page for [Kaam360](https://kaam360.com): whether the service is up, uptime over the last 90 days, and incidents
and planned maintenance posted by the Kaam360 team.

- **How it works:** every 5 minutes a GitHub Actions workflow (`.github/workflows/status-check.yml`) asks `https://kaam360.com/health`
  and the sign-in page, fetches the published incidents (`https://kaam360.com/api/status/incidents`), and writes the result to the
  `gh-pages` branch, which GitHub Pages serves. Because it is hosted by GitHub, the page keeps working when kaam360.com is down.
- **What is in here:** only the page (`status/`) and the checker (`tools/status/`). No Kaam360 application code and no secrets.
- **Source:** these files are maintained in the Kaam360 application repository (`status/`, `tools/status/`) and copied here.
  Change them there, then copy them here.
