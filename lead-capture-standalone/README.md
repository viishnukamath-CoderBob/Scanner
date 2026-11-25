# Lead Capture – GitHub-only version

Just static files. No server, no database, no accounts, no passwords.

## Put it live (about 3 minutes)
1. On GitHub, create a new repository (Public).
2. Upload **everything inside this folder** (`index.html`, `app.js`, `backend.js`, `style.css`, `sw.js`, `manifest.webmanifest`, `icon.svg` and the `vendor` folder) so that `index.html` is at the top level of the repo, not inside a subfolder. Commit.
3. **Settings → Pages → Build and deployment → Deploy from a branch → `main` → `/ (root)` → Save.**
4. After about a minute your link is `https://<your-username>.github.io/<repo-name>/`. It is HTTPS, so the camera works.

## Using it
1. Open the link. It asks for **your name once** (saved on that phone, added to every lead).
2. Pick a demo topic → scan the nametag (or **Enter manually**) → check name and company → Hot / Warm / Cold + notes → **Save lead & scan next**.
3. **Leads** tab: search, filter, edit or delete. **Export Excel** downloads the leads as `.xlsx`.
4. **Dashboard** tab: totals by temperature, topic; add / rename / disable topics; Export Excel.
5. Tap your name (top right) to change it. Tap the topic chip, or **← Change topic**, to switch topic.

## Important limitation – read this
GitHub Pages only serves files; it cannot store data. So **leads are saved in the browser of the phone that captured them**:
- Phones do **not** share data with each other and there is no live sync between devices.
- Each phone has its own topics list.
- Clearing browser data on a phone deletes its leads. **Export to Excel at the end of every day.**
- Use the same browser each time; a private/incognito tab does not keep data.

To get one combined list, collect each phone's exported `.xlsx` and paste the rows into one sheet. If you need all phones to share one live list, you need a shared backend (the Render or Google Sheets versions).
