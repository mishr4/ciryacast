# YouTube setup

The stream key sends video to an existing YouTube Live stream. Keep it secret.

1. Enable live streaming on your YouTube channel. YouTube may take up to 24 hours to activate it the first time.
2. Open YouTube Studio, click **Create**, then **Go live**.
3. Choose **Stream**, create or select a stream, and copy its **Stream key**.
4. Sign in to the TMCast TV website and select the matching channel.
5. Open **Output settings** and paste the stream key.
6. Click **Save securely**, select a scheduled video or enable Auto TV, and click **Start output**.

The default ingest URL is `rtmp://a.rtmp.youtube.com/live2`.

Each channel stores its own encrypted stream key. The key is never returned to the website after it is saved, and one partner cannot access another partner's credentials.

## Automatic channel imports

TMCast uses one server-side API key to import public uploads for every assigned Cirya, NBS, or partner channel:

1. Create a project in Google Cloud Console.
2. Enable **YouTube Data API v3**.
3. Open **APIs & Services**, then **Credentials**.
4. Create an **API key**.
5. In Railway, open the TMCast service and add `YOUTUBE_API_KEY` under **Variables**.
6. Redeploy, then paste a YouTube channel URL or `@handle` into TMCast and select **Assign and sync channel**.

The API key reads public channel metadata and upload playlists. It cannot create broadcasts or change a YouTube account. Those actions would require OAuth 2.0.

Do not put a stream key, API key, or OAuth secret in browser code or source control.
