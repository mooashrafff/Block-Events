# Supabase setup – tables and connection

Follow these steps so the app saves attendees to Supabase and check-in updates the database.

## 1. Create the table in Supabase

1. Open your project: **https://supabase.com/dashboard/project/wrgpjagqfygyibhmtjwu**
2. In the left sidebar click **SQL Editor**.
3. Click **New query**.
4. Open the file **`supabase-schema.sql`** in this folder, copy all its contents, and paste into the SQL Editor.
5. Click **Run** (or press Ctrl+Enter).
6. You should see “Success. No rows returned.” The table **`attendees`** is now created.

## 2. Get your Supabase keys

1. In the Supabase dashboard, go to **Settings** (gear icon) → **API**.
2. Under **Project URL** copy the URL (e.g. `https://wrgpjagqfygyibhmtjwu.supabase.co`).
3. Under **Project API keys** copy the **`service_role`** key (secret). Do not use the `anon` key for the server.

## 3. Connect the app with .env

1. In the project folder, copy the example env file:
   - **Windows (PowerShell):** `Copy-Item .env.example .env`
   - Or create a file named **`.env`** if it doesn’t exist.
2. Open **`.env`** and set:

```env
SUPABASE_URL=https://wrgpjagqfygyibhmtjwu.supabase.co
SUPABASE_SERVICE_ROLE_KEY=paste_your_service_role_key_here
```

3. Save the file. Keep `.env` private (do not commit it to git).

## 4. Restart the server

In the project folder run:

```bash
npm start
```

Then open **http://localhost:3001**, register once, and in Supabase go to **Table editor** → **attendees** to see the new row. When you scan a ticket’s QR (or open the check-in URL), that row’s **attended** and **checkin_time** will update.

You’re done: the app is connected to Supabase.
