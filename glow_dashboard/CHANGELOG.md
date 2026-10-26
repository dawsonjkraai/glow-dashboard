# Changelog

## 0.1.2

- Music: a speaker you untick while music plays is muted at once (so the music never restarts), and
  now let go soon after: out of the group and unmuted at the next song, when the music is paused or
  stopped, or at once when something else (Spotify Connect) takes it. It used to stay muted.

## 0.1.1

- Wall tablets: the add-on's port (8199) is on by default. Before, it started empty, so turning on
  "No sign-in" alone opened nothing. Without "No sign-in" the port only serves the page and every
  tablet signs in with its own Home Assistant account.

## 0.1.0

- First release as a Home Assistant add-on: in the sidebar, signed in as whoever opens it.
- A setup wizard builds a dashboard from your home in five questions.
- Album art, Music Assistant's queue and live WLED colours are handled by the add-on, once for every screen.
- Optional: wall tablets on the add-on's own port, with or without signing in.
