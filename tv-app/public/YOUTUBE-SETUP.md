# YouTube setup

The stream key sends video to an existing YouTube Live stream. Keep it secret.

1. Enable live streaming on your YouTube channel. YouTube may take up to 24 hours to activate it the first time.
2. Open YouTube Studio, click **Create**, then **Go live**.
3. Choose **Stream**, create or select a stream, and copy its **Stream key**.
4. Sign in to the TMCast TV website and select the matching channel.
5. Open **Output settings** and paste the stream key.
6. Click **Save securely**, select a fallback or scheduled video, and click **Start output**.

The default ingest URL is `rtmp://a.rtmp.youtube.com/live2`.

Each channel stores its own encrypted stream key. The key is never returned to the website after it is saved, and one partner cannot access another partner's credentials.

## API access

An API key is useful for reading public YouTube data, but it cannot create or manage your channel's live broadcasts. That requires OAuth 2.0:

1. Create a project in Google Cloud Console.
2. Enable **YouTube Data API v3**.
3. Configure the OAuth consent screen.
4. Create an **OAuth client ID** for a Web application.
5. Add your production callback URL.
6. Add the OAuth client values to Railway's **Variables** screen when API-based broadcast creation is implemented.

Do not put a stream key, API key, or OAuth secret in browser code or source control.
