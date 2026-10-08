# Roku TV Manager

A desktop app for Windows and Mac that watches every Roku TV on your network, keeps the ones that are on from going to sleep, and turns TVs on and off on a schedule.

- **See every TV at a glance:** on, off or not responding, and what's showing (Jellyfin and whether it's playing, HDMI 1–4, Home screen, screensaver, another app).
- **Keep-awake pings:** at an interval you choose (for all TVs or per TV), the app presses a harmless remote button so the TV registers activity and doesn't power-save. By default that's volume down then volume up, which leaves the volume where it was.
- **A TV that's off stays off:** by default a ping is never sent to a TV that's off. Optional settings can turn TVs back on, or bring them back to Jellyfin when someone switches inputs.
- **Schedules:** at set times on set days, turn TVs on (and then open any installed app, switch to an input such as HDMI 2 or Live TV, or go Home), turn them off, open an app, or switch inputs.
- **Manual controls:** ping, power, open Jellyfin, switch inputs (HDMI 1–4, AV, Live TV), Home.
- **Phone access (optional):** open the same dashboard from a phone's browser.
- **Activity log** of everything the app saw and did.

It talks to the TVs with Roku's built-in local control (port 8060). Nothing goes through the internet.

---

## 1. Installing

Download the zip for your computer from the **[latest release](../../releases/latest)**.

### Windows 10 / 11
1. Download **Roku-TV-Manager-…-Windows-x64.zip**, right-click it → **Extract All**. Keep the **Roku TV Manager** folder together, for example in your Documents folder.
2. Double-click **Roku TV Manager.exe**. Windows SmartScreen may say "Windows protected your PC", because the app isn't signed by a registered developer. Click **More info → Run anyway**. You only need to do this once per version.
3. If Windows Firewall asks, tick **Private networks** and click **Allow**. The app needs this to find the TVs.
4. Optional: right-click **Roku TV Manager.exe → Send to → Desktop (create shortcut)**.

### Mac (Apple Silicon or Intel, macOS 12 or newer)
1. Download **Roku-TV-Manager-…-Mac.zip**, double-click it, and drag **Roku TV Manager** into **Applications**.
2. Open it. macOS will say it can't verify the developer, because the app isn't from the App Store. Click **Done**.
3. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to the Roku TV Manager message. You only need to do this once per version.
4. When macOS asks to **find devices on local networks**, click **Allow**. Without this the app can't see any TVs. (To change it later: System Settings → Privacy & Security → Local Network.)

To update, quit the app, replace it with the new version, and repeat the first-launch step if asked. Your TVs, settings and schedules are kept.

## 2. One-time setup on each Roku TV
1. **Settings → System → Power → Fast TV start → On.** This lets the TV answer while it's off, so the app can show "Off" instead of "Not responding" and turn it on from a schedule.
2. **Settings → System → Advanced system settings → Control by mobile apps → Network access → Default.** If the app shows a "refused the request (HTTP 403)" message, set this to **Permissive**.
3. Recommended: in your router, give each TV a **reserved IP address**. If a TV's address changes anyway, click **Search the network** again; the app recognizes TVs by serial number and updates the address.

## 3. Quick start
1. Open Roku TV Manager on a computer that's on the **same network as the TVs**.
2. On the **TVs** tab, click **Search the network**. Your TVs appear as cards within a few seconds. If one doesn't, try **Scan subnet**, or type its IP address (on the TV: Settings → Network → About) and click **Add by IP**.
3. Open **Settings** and check the keep-awake interval and options (section 5). The defaults are a good start.
4. Optional: on **Settings → This computer**, turn on **Start Roku TV Manager when this computer starts**.

## 4. Where it runs, and closing the window
The app does its work (pings, schedules, status checks) only while it's running, and only on the computer it's running on. That computer must stay on and be on the TV network. A computer that's always on, such as the Jellyfin server, is ideal.

- **Closing the window doesn't quit the app.** It keeps running in the **tray** (Windows, bottom-right of the taskbar; you may need to click the ^ arrow) or the **menu bar** (Mac, top-right). Click the icon to reopen the window, pause or resume keep-awake, or **Quit**.
- By default the app keeps the computer from going to sleep while keep-awake is on. The screen can still turn off.
- Run it on **one computer at a time**. Two copies would both ping and both run schedules.

## 5. Settings
| Setting | Default | Notes |
|---|---|---|
| Ping every | 30 min | Keep it shorter than whatever puts the TV to sleep (Roku's "Auto power savings" is usually 4 hours). Each TV can override it from its card (⋯ menu). |
| Ping with these buttons | Volume down, then up | The volume bar flashes for a moment. "Mute, then unmute" is the other preset. Power and Home buttons can't be used here. |
| Which TVs get pinged | Any TV that's on | Or only TVs showing Jellyfin. |
| When a TV is off | Leave it off | Or turn it back on (and optionally open Jellyfin). A TV turned off from the app or by a schedule always stays off until it's turned on from the app or by a schedule. |
| When a TV is on something else | Leave it alone | Or switch it back to Jellyfin at each ping. |
| Target app | Jellyfin (592369) | **Pick from a TV…** lists the apps installed on a TV. |
| Check TV status every | 15 s | |
| Subnet to scan | automatic | For **Scan subnet**, e.g. `192.168.1.0/24`. |
| Start when this computer starts | off | Starts hidden in the tray / menu bar. |
| Keep this computer from sleeping | on | Only while keep-awake is on. |
| Phone access | off | See section 6. |

Schedules use the clock and time zone of the computer running the app. A "Turn on, then …" schedule waits until each TV has finished turning on before opening the app or switching the input. The app list in a schedule comes from the apps installed on your TVs (click ↻ to reload it).

## 6. Phone access
Turn on **Settings → This computer → Phone access** and the app shows an address such as `http://192.168.1.20:8765`. Open it in the browser on any phone or computer on the same network to see and control the TVs. Anyone on your network who opens that address can control the TVs, so only use it on a network you trust. Never forward that port to the internet.

## 7. Troubleshooting
| What you see | What to do |
|---|---|
| **Search the network** finds nothing | Make sure this computer is on the same network (not a guest network) as the TVs. On Mac, allow Local Network access (section 1). On Windows, allow the app through the firewall. Then try **Scan subnet**, or add by IP. |
| A TV says **Not responding** | It's unplugged, off without Fast TV start, or its IP address changed. Click **Search the network**. |
| "refused the request (HTTP 403)" | Set the TV's **Control by mobile apps → Network access** to Default or Permissive (section 2). |
| A TV still goes to sleep | Lower **Ping every**, and check the TV's card shows "Pinged" as the last ping. If it says "Left off" or "Skipped", check the settings in section 5. |
| Schedules didn't run | The app must be running at that time and the computer awake. Check the **Activity** tab. |

The **Activity** tab shows the last 150 events. A longer log is kept in `activity.log` in the settings folder shown at the bottom of **Settings**.

---

## 8. For developers: running from source
Requires [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
npm start        # opens the app
npm test         # runs the tests (uses a fake Roku, no real TVs needed)
```

Code layout:
- `main.js`: Electron main process (window, tray / menu bar, start at login, phone access)
- `preload.cjs`: the one bridge between the window and the main process
- `index.html`: the whole user interface
- `src/core/`: the logic, with no Electron dependency (`ecp.js` talks to TVs, `discovery.js` finds them, `engine.js` runs pings and schedules, `store.js` saves settings, `api.js` is shared by the window and phone access)
- `test/`: tests and a fake Roku TV

## 9. Making a release
GitHub builds the downloads. Bump `"version"` in `package.json` (for example to `1.0.1`), commit, and push to `main`. The **Build and release** workflow runs the tests, builds the Windows and Mac zips, and, because that version hasn't been released yet, publishes release **v1.0.1** with both zips attached. Pushes that don't change the version just build the zips (download them from the workflow run's **Artifacts**) without publishing anything.
