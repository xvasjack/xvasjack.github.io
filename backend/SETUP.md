# Find Target Backend - Setup Guide

## Step 1: Get Your API Keys Ready

You need these 3 things:

### OpenAI API Key
- Go to: https://platform.openai.com/api-keys
- Click "Create new secret key"
- Copy the key (starts with `sk-`)

### Perplexity API Key
- Go to: https://www.perplexity.ai/settings/api
- Generate an API key
- Copy the key (starts with `pplx-`)

### Resend API Key (for sending emails)
- Go to: https://resend.com/api-keys
- Create an API key
- Copy the key
- **Important**: Add and verify your domain at https://resend.com/domains

---

## Step 2: Deploy to Railway (Free)

### 2.1 Create Railway Account
- Go to: https://railway.app
- Sign up with GitHub

### 2.2 Deploy
- Click "New Project"
- Click "Deploy from GitHub repo"
- Select your `xvasjack.github.io` repo
- Railway will ask which folder - select `backend`

### 2.3 Add Environment Variables
In Railway dashboard, go to your project → Variables tab → Add these:

```
OPENAI_API_KEY = sk-your-key-here
PERPLEXITY_API_KEY = pplx-your-key-here
RESEND_API_KEY = your-resend-api-key
SENDER_EMAIL = sj.goh@bluerockvent.com
```

### 2.4 Get Your Backend URL
- Railway will give you a URL like: `https://find-target-backend-production.up.railway.app`
- Copy this URL

---

## Step 3: Update Your Form

Edit `find-target.html` and change line 183:

FROM:
```
action="https://xvasjack.app.n8n.cloud/form/..."
```

TO:
```
action="https://YOUR-RAILWAY-URL.up.railway.app/api/find-target"
```

---

## Done!

Your form will now:
1. Receive submissions
2. Search for companies using AI
3. Email results to the user
