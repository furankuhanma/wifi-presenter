# Wi-Fi Synchronized Classroom Presentation System

Control a slideshow from one device (your laptop) and have every student's
phone automatically follow along in real time — all over your classroom's
Wi-Fi, with **no internet connection required** after setup.

---

## How it works (short version)

- Your laptop runs a small server.
- Students open a URL in their phone's browser and see the current slide.
- You open a separate, PIN-protected controller page.
- When you click **Next** or **Previous**, the server tells every connected
  phone to update instantly (using Socket.IO / WebSockets).

---

## STEP 1 — Install Node.js

You need Node.js installed on the laptop that will run the server (this
does **not** need to be installed on student phones).

1. Go to https://nodejs.org
2. Download the **LTS** version for Windows.
3. Run the installer and click through with the default options.
4. To confirm it worked, open **Command Prompt** and run:

   ```
   node -v
   npm -v
   ```

   You should see version numbers printed for both.

---

## STEP 2 — Get the project onto your laptop

Unzip the project folder you downloaded. You should end up with a folder
called `wifi-presentation` containing `server.js`, `package.json`, etc.

---

## STEP 3 — Open a terminal in the project folder

In File Explorer, open the `wifi-presentation` folder, then:

- Click the address bar at the top of the window.
- Type `cmd` and press Enter.

This opens Command Prompt already inside the correct folder.

(Alternative: hold **Shift**, right-click inside the folder, and choose
**"Open PowerShell window here"** or **"Open command window here."**)

---

## STEP 4 — Install dependencies

In the terminal you just opened, run:

```
npm install
```

This downloads the 4 small libraries the project depends on (Express,
Socket.IO, dotenv, qrcode). **This step needs internet access** — but only
this one-time step. Running the actual presentation later does not.

---

## STEP 5 — Configure your presenter PIN

1. In the project folder, find the file `.env.example`.
2. Make a copy of it and rename the copy to exactly `.env`
   (In Command Prompt, you can instead just run: `copy .env.example .env`)
3. Open `.env` in Notepad and change the PIN if you want:

   ```
   PRESENTER_PIN=1234
   PORT=3000
   ```

You can leave both as-is for your first test.

---

## STEP 6 — Start the server

In the terminal, run:

```
npm start
```

You should see output like this:

```
=================================================
 Wi-Fi Synchronized Classroom Presentation System
=================================================
Server running on port 3000
Presenter PIN: 1234

On THIS computer, open:
  Presenter view: http://localhost:3000/presenter

Students on the same Wi-Fi should open:
  http://192.168.1.5:3000
  (This URL is also shown as a QR code on the presenter page.)
=================================================
```

Keep this terminal window open — closing it stops the server.

---

## STEP 7 — Find your laptop's local IP address (if needed)

The server tries to detect this automatically and prints it in the terminal
(as shown above). If you ever need to find it manually:

**Windows:**

```
ipconfig
```

Look for **"IPv4 Address"** under the network adapter you're using
(usually "Wireless LAN adapter Wi-Fi"). It will look like `192.168.x.x`.

**Mac / Linux** (if you ever run this on one instead):

```
ifconfig
```

or

```
ip addr
```

> If the auto-detected IP in the terminal ever looks wrong (this can happen
> if your laptop has a VPN or multiple network adapters), open `.env` and
> add a line like:
> ```
> HOST_IP=192.168.1.5
> ```
> using the correct address from `ipconfig`, then restart the server.

---

## STEP 8 — Connect everyone to the same Wi-Fi

Make sure your laptop **and** every student phone are connected to the
**same Wi-Fi router**. This is required — the app will not work across
different networks.

---

## STEP 9 — Open the presenter controller (on your device)

On your laptop (or your own phone), open:

```
http://localhost:3000/presenter
```

(If you're presenting from your phone instead of your laptop, use your
laptop's IP address instead of `localhost`, e.g.
`http://192.168.1.5:3000/presenter`.)

Enter the PIN from your `.env` file to unlock the controls.

---

## STEP 10 — Get students connected

Students should open, in their phone's browser:

```
http://YOUR-LAPTOP-IP:3000
```

Example: `http://192.168.1.5:3000`

The easiest way: have them **scan the QR code** shown on your presenter
page — it's generated automatically and always points to the correct
address.

---

## STEP 11 — Test the synchronization

1. On the presenter page, click **Next**.
2. Every connected student phone should immediately change to the next
   slide.
3. Try having a student close their browser tab and reopen the URL — they
   should immediately see the current slide, not slide 1.

---

## Using your own PowerPoint presentation

You don't have to retype your slides by hand. If your presentation is a
`.pptx` file, you can import it automatically:

1. Copy your `.pptx` file into the `wifi-presentation` project folder
   (same folder as `server.js`).
2. In your terminal (inside the project folder), run:

   ```
   npm run import -- "Your File Name.pptx"
   ```

   (Keep the quotes if the filename has spaces, like in the example above.)

3. This reads your PowerPoint file and rewrites `slides.js` with your real
   titles and bullet points. Your previous `slides.js` is automatically
   saved as `slides.backup.js` first, just in case.
4. Restart the server (`Ctrl+C`, then `npm start`) to see your new slides.

**Reusing this for a different presentation later:** just run the same
command again with the new filename — it will overwrite `slides.js` again.

**What gets imported:** slide titles and text/bullet content. **What does
NOT get imported:** images, tables, charts, and SmartArt — those are
skipped for now (you can add an image to any slide afterward by editing
`slides.js` directly; see the comments at the top of that file).

**How the title is detected:** if your template uses a real PowerPoint
"Title" placeholder, that's used automatically. Many nicely-designed
templates (especially ones from template marketplaces) use plain text
boxes instead — in that case, the biggest piece of text on the slide is
used as the title instead. Any text smaller than 10pt is treated as
decorative clutter and skipped, since real slide content is almost never
that tiny. Very elaborate custom slide layouts may still not extract
perfectly, so it's worth a quick glance over the generated `slides.js`
afterward.

---

## Editing your presentation content by hand

You can also skip the import and edit `slides.js` directly — it's a plain
JavaScript array, each `{ ... }` block is one slide. Full instructions are
in the comments at the top of that file. You can:

- Add or remove slides freely.
- Use `title`, `content`, `bullets`, and (optionally) `image` on each slide.
- Restart the server (`Ctrl+C` then `npm start` again) after editing, so it
  picks up your changes.

---

## Project structure

```
wifi-presentation/
│
├── server.js          # The backend: Express + Socket.IO + slide state
├── slides.js           # Your presentation content (edit this!)
├── import-pptx.js        # Converts a .pptx file into slides.js
├── package.json         # Project dependencies
├── .env.example          # Template for your configuration
├── .env                   # Your actual config (PIN, port) — you create this
│
└── public/
    ├── index.html        # Student view (route: /)
    ├── viewer.js          # Student-side sync + connection status logic
    ├── presenter.html    # Presenter view (route: /presenter)
    ├── presenter.js        # Presenter controls, PIN login, QR code
    └── style.css            # Shared styling for both views
```

---

## Troubleshooting

**Students can't reach the page at all**
- Confirm the phone and laptop are on the *same* Wi-Fi network (not one on
  Wi-Fi and one on mobile data).
- Some routers isolate devices from each other ("AP/client isolation" or
  "guest network isolation") for security — check your router settings if
  this is enabled, as it will block this app from working.
- Windows Firewall may prompt you the first time you run `npm start` —
  choose **"Allow access"** for both Private and Public networks.

**The QR code / student URL shows the wrong IP address**
- Add `HOST_IP=your.correct.ip` to your `.env` file (see Step 7) and
  restart the server.

**"Incorrect PIN" even though I typed it correctly**
- Make sure there's no extra space in your `.env` file after
  `PRESENTER_PIN=`.
- Restart the server after changing `.env` — it's only read on startup.

**Slides don't advance on student phones**
- Make sure you're clicking Next/Previous on the `/presenter` page (which
  requires the PIN), not the plain student page.

**I refreshed the presenter page and it asks for the PIN again**
- That's expected — refreshing creates a brand-new connection, so you'll
  need to re-enter the PIN. The current slide itself is not lost, since
  that's tracked by the server, not your browser.

---

## Planned for later (not built yet, but the code is structured for it)

- Uploading PowerPoint/PDF files instead of editing `slides.js` by hand
- Multiple saved presentations to switch between
- Live polls / quizzes
- Student questions
- Attendance tracking
- Presenter-only notes

---

## Quick command reference

| Action                          | Command                  |
|----------------------------------|---------------------------|
| Install dependencies (first time)| `npm install`              |
| Start the server                  | `npm start`                 |
| Stop the server                    | `Ctrl + C` in the terminal   |
| Find your local IP (Windows)        | `ipconfig`                    |
