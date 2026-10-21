# recap share page

The page a shared year recap opens on: the card (tilts, flips) and every number behind it. One file, no build step. `index.html` has its CSS and JS inline, fonts come from Google Fonts.

The server serves it once per share and fills in:

- `{{payload}}` in the `recap-data` script block, the share's JSON with every `<` written as `\u003c` so a clip title can't close the tag
- `{{title}}`, `{{description}}`, `{{url}}`, `{{image}}`, `{{image_alt}}` in the head, for link previews

The payload is what `sharePayloadWithPics()` in `src/renderer/recap/share.ts` returns (`v: 1`). Game art on disk goes in as a small inlined webp, pictures only on Discord (avatars) as links the server copies to `/r/<id>/img/`, anything else inlined too, so the server never needs game art of its own.

A payload is whatever someone uploaded, so the page only loads pictures from https or inlined `data:image` urls, only takes plain colour values, and puts everything else in as text.

## trying it locally

```
python -m http.server 8080 -d web/recap-share
```

Then open http://localhost:8080/. With the block left unfilled it loads `sample.json`, a made-up year. `?src=<url>` loads another payload instead; it's only read when the block is unfilled, so a share link can't be pointed at someone else's file.

For your own numbers run `__recapShare()` in the dev app's devtools console (`__recapShare({ friends: true })` to include the crew), save the file into this folder and open `?src=setsu-recap-2026.json`. Don't commit it.
