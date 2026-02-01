# Gmail OAuth Setup (One-Time)

The agent uses Gmail API (read-only) to check for email results. This requires a one-time OAuth setup.

## Step 1: Google Cloud Console

1. Go to https://console.cloud.google.com/
2. Create a new project (or use an existing one)
3. Enable the **Gmail API**:
   - Go to **APIs & Services > Library**
   - Search "Gmail API" and click **Enable**

## Step 2: Create OAuth Credentials

1. Go to **APIs & Services > Credentials**
2. Click **Create Credentials > OAuth client ID**
3. If prompted, configure the OAuth consent screen:
   - User type: **External**
   - App name: anything (e.g. "AI Agent")
   - Add your email as a test user
4. Application type: **Desktop app**
5. Click **Create**
6. Download the JSON file

## Step 3: Place the Credentials File

Save the downloaded JSON as:

```
C:\agent\windows\credentials\gmail_credentials.json
```

Or set an environment variable in `start.ps1`:

```powershell
$env:GMAIL_CREDENTIALS_PATH = "C:\path\to\gmail_credentials.json"
```

## Step 4: One-Time Authorization

Run this once on the Windows VM (with a browser available):

```powershell
cd C:\agent\windows
.\venv\Scripts\Activate.ps1
python -c "from actions.gmail_api import _get_gmail_service; _get_gmail_service()"
```

A browser window will open. Sign in with **xvasjack@gmail.com** and grant read-only Gmail access.

This creates `credentials/gmail_token.json` automatically. Future runs use this token (auto-refreshes).

## Step 5: Verify

```powershell
python -c "from actions.gmail_api import search_emails_api; print(search_emails_api('newer_than:1d', max_results=1))"
```

Should return a list of recent emails (or empty list if none match).

## Troubleshooting

- **"Access blocked" error**: Add your email as a test user in the OAuth consent screen
- **Token expired**: Delete `credentials/gmail_token.json` and repeat Step 4
- **Wrong account**: Delete the token file and re-authorize with the correct account
