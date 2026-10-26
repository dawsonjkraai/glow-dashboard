# Glow Dashboard

A touch-first dashboard for wall tablets and phones. Answer a few questions and it builds your
dashboard from what your home has: lights, climate, music, cameras, locks, calendars and more. Every
card can then be moved, resized and swapped by touch.

## Getting started

1. Install the add-on and press **Start**.
2. Turn on **Show in sidebar** and open **Glow** from Home Assistant's sidebar.
3. The setup asks where the screen goes, what it should show, which rooms and which look, and draws
   the pages before it makes them. Press **Build it**.

Your dashboards are kept in Home Assistant, so every screen and phone sees the same ones.

## Wall tablets

A tablet can show the dashboard two ways.

**Through Home Assistant (recommended).** Sign the tablet in to Home Assistant (a user of its own,
like "Kitchen tablet", works well) and open **Glow** from the sidebar. For a kiosk browser such as
Fully Kiosk, open Glow from the sidebar once and use the address your browser shows then as the
kiosk's start page.

**On the add-on's own port.** Open `http://<your Home Assistant's IP>:8199/` on the tablet. It asks
for your Home Assistant's address and a sign-in the first time (or none at all with **No sign-in**,
below). The port is on by default; change its number, or clear it to close it, under the add-on's
**Network** settings, then restart the add-on.

### No sign-in

With **No sign-in on the home network** turned on, tablets that open the add-on's port show the
dashboards without signing in at all. The add-on then acts for them with the access Home Assistant
gives add-ons. It refuses the dangerous parts (add-ons, backups, restarts, accounts), but anyone on
your Wi-Fi could still switch your lights, unlock a door or watch a camera through it. **Only turn it
on for a home network you trust**, never on a guest network. The sidebar always uses your own
sign-in either way.

## What runs in the add-on

Besides serving the dashboard, the add-on does a few jobs once for every screen, so a cheap tablet
doesn't have to:

- **Album art** from music services is kept on your Home Assistant's disk and served on your home
  network.
- **Music Assistant**: the queue (moving and removing songs), starting a playlist at any song, and
  big playlists a page at a time. It uses Music Assistant's own API through Home Assistant, with
  nothing to set up.
- **WLED**: live colours of your strips, followed once and shared with every screen.

## Requirements

- Home Assistant OS or Supervised (add-ons need the Supervisor). On other installs, use the panel's
  zip install from the project's page instead.
- A browser from the last few years. It is tuned for the Amazon Fire HD 10 (Chromium 114).

## Privacy

The dashboard talks only to your Home Assistant and, for album art, to the music services' own
picture servers. Nothing is sent anywhere else.
