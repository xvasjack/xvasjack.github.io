# Deal Tools

Web tools for M&A research work. Each tool is a form on a static web page. The form sends the request to a backend service, and the result arrives by email.

| Tool | What it does | Output |
|---|---|---|
| Target search (v3 to v6) | Finds companies that match a business type and country | Excel |
| List validation | Checks an uploaded company list against an industry or criteria | Excel |
| Trading comps | Filters an uploaded company list and builds a comps table | Excel, PPT |
| Profile slides | Builds company profile slides from company websites | PPT |
| Market research | Researches a market from a short brief | PPT |
| Business overview | Summarises a company's business on one slide | PPT |
| DD report | Summarises uploaded documents into a due diligence report | Word |
| Company metrics | Pulls revenue and headcount from company websites | Excel |
| Translation | Translates the text in a PowerPoint file and keeps the layout | PPT |

## How it works

- Frontend: plain HTML, CSS and JavaScript in the repo root, hosted on GitHub Pages.
- Backend: one Express.js service per tool in `backend/`, deployed on Railway.
- Services call AI models (OpenAI, Anthropic, Google Gemini) and web search (Perplexity, SerpAPI), then email the file through SendGrid.

## Run locally

```bash
cd backend
npm install
npm test
```

Copy `backend/.env.example` to `.env` and add your own API keys before running a service.

## Notes

- Built with the help of Claude Code.
