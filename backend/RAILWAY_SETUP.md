# Railway Multi-Service Setup Guide

This backend is split into 10 independent services. Each deploys separately on Railway, so updating one doesn't affect others.

## Services

| Service | Folder | Endpoints |
|---------|--------|-----------|
| Target V3 | `backend/target-v3/` | `/api/find-target`, `/api/find-target-slow` |
| Target V4 | `backend/target-v4/` | `/api/find-target-v4` |
| Target V5 | `backend/target-v5/` | `/api/find-target-v5` |
| Validation | `backend/validation/` | `/api/validation` |
| Trading Comparable | `backend/trading-comparable/` | `/api/trading-comparable` |
| Profile Slides | `backend/profile-slides/` | `/api/profile-slides` |
| Financial Chart | `backend/financial-chart/` | `/api/financial-chart` |
| UTB | `backend/utb/` | `/api/utb` |
| Due Diligence | `backend/due-diligence/` | `/api/due-diligence` |
| Transcription | `backend/transcription/` | `/api/transcription-*`, `/api/recording-*` |

## Setup Steps (for each service)

### 1. Create Railway Project
- Go to [Railway Dashboard](https://railway.app/dashboard)
- Click "New Project" → "Deploy from GitHub repo"
- Select `xvasjack/xvasjack.github.io`

### 2. Configure Root Directory
- Go to Settings → General
- Set **Root Directory** to the service folder (e.g., `backend/target-v3`)

### 3. Add Environment Variables
Go to Variables tab and add:
```
OPENAI_API_KEY=your-key
PERPLEXITY_API_KEY=your-key
GEMINI_API_KEY=your-key
SENDGRID_API_KEY=your-key
SENDER_EMAIL=your-email
```

Optional (depending on service):
```
ANTHROPIC_API_KEY=your-key
DEEPSEEK_API_KEY=your-key
DEEPGRAM_API_KEY=your-key
SERPAPI_API_KEY=your-key
R2_ACCOUNT_ID=your-id
R2_ACCESS_KEY_ID=your-key
R2_SECRET_ACCESS_KEY=your-secret
R2_BUCKET_NAME=your-bucket
```

### 4. Deploy
Railway auto-deploys on push. Each service only redeploys when its folder changes.

## Frontend Configuration

Update your HTML files to point to the correct service URLs:

```javascript
// Example: find-target.html
const API_URL = 'https://your-target-v3-service.up.railway.app';

// Example: find-target-v4.html
const API_URL = 'https://your-target-v4-service.up.railway.app';
```

## How It Works

- Each folder is a separate Railway project
- Railway watches only that folder for changes
- Merge PR that touches `validation/` → only validation redeploys
- Other services stay up and running
