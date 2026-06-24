# Jacket Mode Implementation Plan

## Goal

Add a full jacket quiz mode alongside the existing intro quiz mode without leaving mixed or half-intro assumptions in the runtime, UI, or regression specs.

The host starts a game with either intro mode or jacket mode. Intro mode keeps the current behavior: players buzz after hearing a short MusicKit playback. Jacket mode shows an obfuscated album jacket and players guess the album name.

## Non-Negotiables

- The existing intro mode must keep working.
- The new jacket mode must be complete in the same implementation pass: backend state, console UI, gameboard UI, action button behavior, MusicKit data extraction, and specs.
- The `console:start` event should remain the start event and receive a payload such as `{ quizMode: 'intro' | 'jacket' }`.
- The UI and internal game feature naming should use `jacket`, not `artwork`.
- Apple Music image URL fields may remain `artwork*Url` because they describe the upstream resource.
- Jacket hint strength is a percent value, not seconds.
- Jacket mode must not introduce an extra "show hint" button. Controls update the shared state directly.

## Product Behavior

### Game Start

Replace the single preparation button with two start buttons:

- `イントロで開始`
- `ジャケットで開始`

Both call `console:start` with a `quizMode` payload. Starting either mode should shuffle tracks, reset scores, load the first round, and set the shared game state to the selected mode.

### Intro Mode

Intro mode keeps the current host progress layout:

- Playback seconds slider
- `再生`
- `ギブアップ`
- `正解`
- `不正解`
- Next/result/next-game controls below the divider

Players can buzz during playback and after playback has ended for the same round, matching current behavior.

### Jacket Mode

Jacket mode replaces the playback controls with jacket controls:

- Obfuscation mode combobox
- Grayscale switch
- Hint percent slider
- `ギブアップ`
- `正解`
- `不正解`
- Next/result/next-game controls below the divider

The gameboard should reflect jacket control changes immediately through shared state. The action button should be accepted during a jacket round once the current round is ready, without requiring audio playback.

The correct answer is the album name. Reveal should show the original jacket image, album name as the primary answer, and supporting track/artist details.

## Jacket Data Model

Add quiz mode state:

```ts
export type QuizMode = 'intro' | 'jacket'
```

Add jacket obfuscation mode state:

```ts
export type JacketMode =
  | 'pixelated'
  | 'missingBlocks'
  | 'tileShuffle'
  | 'circleReveal'
  | 'zoomRotateCrop'
  | 'edgeReveal'
```

Extend `Track`:

```ts
export type Track = {
  id: string
  title: string
  artist: string
  albumName: string
  artworkChipUrl?: string
  artworkInfoUrl?: string
  artworkRevealUrl?: string
}
```

Extend `GameState`:

```ts
export type GameState = {
  phase: Phase
  step: GameStep
  quizMode: QuizMode | null
  selectedPlaylistIds: string[]
  players: Player[]
  tracks: Track[]
  shuffledTrackIds: string[]
  roundIndex: number
  answererId: string | null
  jacketMode: JacketMode
  jacketGrayscale: boolean
  jacketHintPercent: number
}
```

Defaults:

- `quizMode: null`
- `jacketMode: 'pixelated'`
- `jacketGrayscale: false`
- `jacketHintPercent: 1`

Reset and next-game should return `quizMode` to `null`. Jacket settings may reset to defaults on reset and may either persist or reset on next game; prefer resetting to defaults when returning to ready so a fresh game is predictable.

## Step Semantics

Keep existing `GameStep` values for compatibility, but interpret them by quiz mode.

Intro:

- `beforePlayback`: round ready, waiting for playback
- `playing`: intro is playing and buzz is accepted
- `answering`: player has answer rights
- `reveal`: song/track reveal

Jacket:

- `beforePlayback`: jacket round ready and buzz is accepted
- `playing`: unused for jacket mode
- `answering`: player has answer rights
- `reveal`: album jacket and album name reveal

Avoid introducing a separate jacket-only step unless the implementation becomes clearer with a broader state refactor. The first complete pass should minimize state migration risk.

## Backend Changes

### Server State

Update `server/index.ts` internal state and `publicState()` to carry the new fields.

Replace `roundIntroPlayed` with intro-specific naming:

```ts
let roundIntroPlayed = false
```

Keep it intro-only. Do not let jacket mode depend on it.

### Track Intake

Update `consoleSelectPlaylists` to preserve `albumName`. Filter selected tracks by `id` and `title` as today; do not require album name to keep compatibility with mocks and unusual MusicKit data. Use a fallback such as `track.albumName ?? ''`.

### Start Event

Change `consoleStart` to accept a payload:

```ts
type ConsoleStartPayload = {
  quizMode?: unknown
}
```

Validation:

- Only `'intro'` and `'jacket'` are accepted.
- Missing or invalid mode returns an error.
- Starting without tracks remains rejected.

Socket handler shape:

```ts
socket.on('console:start', (payload, callback) => acknowledge(callback, () => consoleStart(payload)))
```

Keep backward compatibility only if existing tests are updated at the same time. Because the UI will always send a mode, specs should assert that mode is required.

### Play Events

`console:play` and `console:play-ended` should be valid only when `quizMode === 'intro'`.

### Jacket Settings Events

Add server actions:

- `console:set-jacket-mode`
- `console:set-jacket-grayscale`
- `console:set-jacket-hint-percent`

Each should be valid during a jacket game when the round is in `beforePlayback`. They may also be valid during `answering` if the host needs to adjust while a player is answering; prefer limiting to `beforePlayback` first unless UI demands otherwise.

Validation:

- `jacketMode` must be one of the defined modes.
- `jacketGrayscale` must be boolean.
- `jacketHintPercent` must clamp or reject outside `1..100`. Prefer rejecting invalid values in the server and clamping only in the UI.

### Action API

Update answerability:

```ts
const canAnswerIntro = state.quizMode === 'intro'
  && (state.step === 'playing' || (state.step === 'beforePlayback' && roundIntroPlayed))

const canAnswerJacket = state.quizMode === 'jacket'
  && state.step === 'beforePlayback'
  && state.roundIndex >= 0

const canAnswer = canAnswerIntro || canAnswerJacket
```

Keep existing behavior:

- Unjoined player receives `409`.
- Later buzzers after an answerer receive `204`.
- Rejected actions do not consume cooldown.

### Judging, Give Up, Next Round

Judging can stay mostly shared:

- Correct increments the answerer score and moves to `correct`.
- Wrong moves to `wrong`.
- Correct feedback goes to `reveal`.
- Wrong feedback returns to `beforePlayback`.

Mode-specific differences:

- In intro mode, wrong feedback returns to replay-ready behavior with the same `roundIntroPlayed` value as before if current behavior should stay. Current server leaves `roundIntroPlayed` true after wrong feedback; preserve this unless specs say otherwise.
- In jacket mode, wrong feedback returns to the same obfuscated jacket state and remains buzzable.
- Give up remains valid from `beforePlayback` in both modes.
- Next round resets `roundIntroPlayed` and keeps jacket settings at their current values unless product wants per-round reset. Prefer preserving host jacket settings across rounds for faster play.

## MusicKit Data Changes

Update `client/useMusicKitLibraryQueries.ts`:

- Add `albumName?: string` to `MusicApiAttributes`.
- Populate `Track.albumName` from library or catalog attributes.
- Prefer catalog album name if present, then library album name, then `''`.

Example:

```ts
albumName: catalog?.attributes?.albumName ?? track.attributes?.albumName ?? '',
```

Update mocks in `spec/step_defs/frontend/musickit_mock.py` and helpers to include album names.

## Console UI Changes

### Preparation Section

Replace the existing `ゲーム開始` button with:

- `イントロで開始`
- `ジャケットで開始`

Both disabled under the same conditions as the current start button. Both call `console:start` with the selected mode.

### Progress Section Split

Extract the progress controls into mode-specific components to avoid an unreadable `ConsolePage`:

- `IntroProgressControls`
- `JacketProgressControls`

Intro controls own:

- Playback seconds label
- `CircularSecondsSlider`
- Play/give-up/correct/wrong buttons

Jacket controls own:

- Jacket mode combobox
- Grayscale switch
- Percent slider
- Give-up/correct/wrong buttons

The lower next/result/next-game block can stay shared.

### Slider Component

Refactor `CircularSecondsSlider` into a generic base plus wrappers:

- `CircularValueSlider`
- `CircularSecondsSlider`
- `CircularPercentSlider`

Avoid making the state field generic. Only the UI control should be shared.

### Status Text

Update `consoleStatusMessage` to accept enough context for both modes, or split it by mode.

Intro examples:

- `再生秒数を指定して、再生ボタンを押してください`
- `${playbackSeconds}秒再生中。早押し待ちです`

Jacket examples:

- `ジャケットのヒントを調整できます。早押し待ちです`
- `解答権が取られました`
- `正解発表中です`

### Round Info Disclosure

Current `RoundTrackDisclosure` exposes track title. For jacket mode:

- Before reveal, avoid exposing album name.
- It may still show track title/artist if that is acceptable, but this can leak clues. Prefer hiding detailed round info during jacket mode before reveal or showing only operational status.
- After reveal, show album name, track title, and artist.

## Gameboard UI Changes

### Shared Round Data

Use `roundTrackFromState(state)` as today. Add album name where needed.

### Intro Rendering

Keep current:

- `beforePlayback`: inactive note
- `playing`: pulsing note
- `answering`: answer prompt
- `reveal`: track title, artist, artwork

### Jacket Rendering

When `state.quizMode === 'jacket'` and step is `beforePlayback`, show the obfuscated jacket image instead of the note stage.

When `state.quizMode === 'jacket'` and step is `answering`, keep the answer prompt and player highlight. Consider keeping a smaller dimmed jacket behind or above only if it does not clutter.

When `state.quizMode === 'jacket'` and step is `reveal`, show:

- Original jacket image
- Album name as the main answer
- Track title and artist as supporting detail

### Jacket Canvas Renderer

Create a component such as `JacketCanvas` or `ObfuscatedJacket`:

```ts
type ObfuscatedJacketProps = {
  src: string
  mode: JacketMode
  grayscale: boolean
  hintPercent: number
}
```

Use a canvas so all modes share image loading, sizing, high-DPI output, and grayscale processing.

Important implementation rules:

- Use CORS-compatible image loading if needed: `image.crossOrigin = 'anonymous'`.
- Set canvas backing size with `devicePixelRatio`.
- Draw into a square canvas with `object-fit: cover` behavior.
- Memoize deterministic randomness per round. Use a seed based on `track.id`, `roundIndex`, and `mode` so rendering is stable across clients and re-renders.
- Do not re-randomize when `hintPercent` changes.

## Jacket Obfuscation Modes

All modes interpret `hintPercent` as `1..100`, where higher is easier.

### `pixelated`

Nearest-neighbor coarse resolution.

- Convert percent to sample resolution.
- `1%`: very coarse, around `4x4` or `6x6`.
- `100%`: original image.
- Draw the source image into a small offscreen canvas.
- Draw the offscreen canvas to the output canvas with `imageSmoothingEnabled = false`.

### `missingBlocks`

Square grid blocks are hidden and gradually revealed.

- Use a fixed grid, for example `10x10` or `12x12`.
- `hintPercent` controls the percent of visible blocks.
- Generate a deterministic random order of all blocks.
- Draw the original image, then cover unrevealed blocks with the board background or a neutral mask; or draw only revealed blocks onto an empty background.

### `tileShuffle`

Square tiles start shuffled and gradually return to their correct positions.

- Use a fixed grid, for example `6x6` or `8x8`.
- Generate one deterministic shuffled mapping per round.
- `hintPercent` controls how many tiles are restored to their correct positions.
- The non-restored tiles stay in the initial shuffled mapping. Do not reshuffle on every percent change.
- At `100%`, all tiles must be in the correct position.

### `circleReveal`

The image starts blank and circular visible areas accumulate.

- Generate deterministic circles with center and radius.
- `hintPercent` controls visible area by adding more circles and/or increasing radius.
- Circles should remain as percent increases.
- Draw a mask and reveal the source image through the circles.

### `zoomRotateCrop`

The image starts as a zoomed, rotated crop and returns to normal.

- `1%`: strong zoom and rotation.
- `100%`: no zoom, no rotation.
- Use deterministic crop center and initial rotation per round.
- Interpolate zoom and rotation from hard to easy as percent increases.

### `edgeReveal`

The image is visible from all four edges at the same time.

- At `1%`, show a frame that is 1% of the image width/height from every edge.
- Increasing percent expands the visible frame inward.
- At `100%`, show the full image.
- The center stays hidden longest.

### Grayscale Modifier

Apply grayscale after the selected mode is rendered, or before mode rendering if implementation is simpler and visually equivalent. It must be available for every jacket mode.

## Styling and Accessibility

- Use a familiar combobox/select for jacket mode.
- Use a switch/checkbox for grayscale.
- Use the circular percent slider for hint percent.
- Keep controls dense and operational, matching the current console style.
- Ensure button labels and slider text fit on mobile.
- Ensure the gameboard canvas has stable dimensions and does not shift layout when the image loads.
- Provide useful `aria-label`s for the mode select, grayscale switch, and percent slider.

## Specs to Update or Add

### Backend Specs

Update existing start steps:

- `the host starts the game` should pass `{ quizMode: 'intro' }` unless the scenario is mode-specific.
- Add coverage that `console:start` rejects missing/invalid mode.
- Add coverage that starting intro sets `quizMode` to `intro`.
- Add coverage that starting jacket sets `quizMode` to `jacket`.

Add jacket action scenarios:

- Joined player can buzz during a jacket round without playback.
- Unjoined player cannot buzz during a jacket round.
- Later buzzers are ignored after answerer is fixed.
- Wrong answer returns to the same jacket round and remains buzzable.
- Give up reveals from a jacket round.

Add jacket setting scenarios:

- Host can set jacket mode during a jacket round.
- Host can toggle grayscale during a jacket round.
- Host can set hint percent during a jacket round.
- Invalid jacket mode / hint percent are rejected.
- Jacket setting events are rejected during intro games.

### Frontend Specs

Update preparation:

- Console shows `イントロで開始` and `ジャケットで開始`.
- `イントロで開始` starts intro mode and enables the play button.
- `ジャケットで開始` starts jacket mode and shows jacket controls, not the play button.

Add jacket controls:

- Mode combobox changes backend `jacketMode`.
- Grayscale switch changes backend `jacketGrayscale`.
- Percent slider changes backend `jacketHintPercent`.
- Jacket mode does not show `再生`.

Add gameboard:

- Jacket before-playback view shows the jacket canvas, not the music note.
- Changing hint percent updates the jacket rendering.
- Jacket reveal shows album name as the primary answer.

Add data extraction:

- MusicKit playlist tracks include album names in selected backend tracks.

### Integration Specs

Keep existing intro full-session scenarios.

Add at least one full jacket session:

- Host logs in and selects a playlist.
- Player joins.
- Host starts jacket mode.
- Gameboard shows obfuscated jacket.
- Player presses action button and gets answer rights.
- Host marks correct.
- Reveal shows album name.
- Results show score.

Add one wrong-answer jacket session if test runtime remains reasonable:

- Wrong answer returns to same jacket round.
- Another player can buzz.

## Documentation Updates

Update `README.md` after implementation:

- App is no longer intro-only.
- Explain the two game modes.
- Explain start buttons.
- Explain jacket controls and modes.
- Update WebSocket events.
- Update game step descriptions to be mode-aware.

Update titles only if the product name changes. If the app name remains `早押しイントロクイズ`, leave titles for now; otherwise change them consistently across HTML and specs.

## Suggested Implementation Order

1. Extend types and initial state with `quizMode`, jacket settings, and `albumName`.
2. Update MusicKit mapping and test helpers to provide album names.
3. Update backend start payload, mode validation, reset/next-game state, and intro-only play events.
4. Add backend jacket setting events.
5. Update action API answerability by mode.
6. Update backend specs and make them pass.
7. Refactor console progress controls and split start buttons.
8. Add jacket controls and wire them to backend state.
9. Add the generic circular slider and percent wrapper.
10. Implement `ObfuscatedJacket` canvas renderer with all six modes and grayscale.
11. Update gameboard mode-specific rendering and reveal content.
12. Update frontend and integration specs.
13. Update README.
14. Run `bun run typecheck`, `bun run lint`, and `bun run test:spec`.

## Open Decisions Before Implementation

- Should jacket settings persist across rounds within the same game? Recommended: yes.
- Should jacket settings reset when returning to ready with `次のゲームへ`? Recommended: yes.
- Should round info disclose track title before reveal in jacket mode? Recommended: no, or at least hide album name.
- Should a player be allowed to buzz immediately after jacket round loads? Recommended: yes, because there is no explicit display/start button.
- Should `console:start` preserve backward compatibility when no payload is sent? Recommended: no, because the UI and specs should make mode selection explicit.
