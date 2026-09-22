# Import and upgrade Genie Buddy Flow

## Goal
Bring the complete public repository into this project, keep its script-to-manga and video workflow intact, and replace repetitive box-panel compositions with a richer comic-page framing system.

## Implementation
- Import the repository’s application code and compatible dependencies into the existing TanStack Start project.
- Preserve timestamp parsing, character continuity, prompt batching, generation retries, progress recovery, diagnostics, image repair, and browser video export.
- Keep the supplied Z.ai and Agnes credentials out of committed source and access them only through protected runtime configuration.
- Retain the requested Z.ai free-model strategy and Agnes Image 2.5 Flash image generation model.
- Replace the current small set of simple frame descriptions with a deterministic curated layout library covering:
  - stacked wide strips
  - vertical side-by-side compositions
  - dramatic splash frames with inset reactions
  - overlapping circular focus frames
  - diagonal slash divisions
  - floating vignette frames
  - border-breaking action and effects
  - fluid atmospheric transitions
- Select layouts according to frame count and scene character while maintaining clear reading order, consistent characters, and 16:9 output.
- Ensure single-frame moments remain full-bleed rather than being forced into unnecessary grids.

## Validation
- Verify the imported app compiles with the project’s supported runtime.
- Exercise script parsing and the opening generation flow in the live preview.
- Confirm the redesigned panel directives reach the image request and remain deterministic for saved runs.
- Check the interface at mobile and desktop sizes for readable, non-overlapping controls and panel previews.
- Test the configured AI calls once and surface any provider-side credit, access, or model limitation exactly as returned.
