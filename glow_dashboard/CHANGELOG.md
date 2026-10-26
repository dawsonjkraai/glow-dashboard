# Changelog

## 0.1.3

- Home Assistant's add-ons are called apps since 2026.2: Glow's own words follow (the documentation,
  and "App" for what an integration needs in Settings › Integrations).
- Settings › About calls it Glow Dashboard, and an empty dashboard's tip names the button it has,
  **Set it up for me**.
- A project site with a live demo house and guides: https://dawsonjkraai.github.io/glow-dashboard/

## 0.1.2

- Music: a speaker you untick while music plays is muted at once (so the music never restarts), and
  now let go soon after: out of the group and unmuted at the next song, when the music is paused or
  stopped, or at once when something else (Spotify Connect) takes it. It used to stay muted.

## 0.1.1

- Wall tablets: the app's port (8199) is on by default. Before, it started empty, so turning on
  "No sign-in" alone opened nothing. Without "No sign-in" the port only serves the page and every
  tablet signs in with its own Home Assistant account.

## 0.1.0

- First release as a Home Assistant app (an add-on, before Home Assistant 2026.2): in the sidebar, signed in as whoever opens it.
- A setup wizard builds a dashboard from your home in five questions.
- Album art, Music Assistant's queue and live WLED colours are handled by the app, once for every screen.
- Optional: wall tablets on the app's own port, with or without signing in.
