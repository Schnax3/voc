---
name: api-seed-vc-pinokio-git
description: Use the Seed-VC Gradio API for local V1/V2 voice conversion with source and reference audio.
---

# Seed-VC API

## Operations

- Upload audio with multipart field `files` to `/gradio_api/upload`; use the returned file path in a Gradio `FileData` value.
- V2 conversion uses `POST /gradio_api/call/predict` with ordered `data` values: source audio, reference audio, diffusion steps, length adjustment, intelligibility CFG, similarity CFG, top-p, temperature, repetition penalty, style conversion, anonymization.
- Read the returned `event_id` from `GET /gradio_api/call/predict/{event_id}` until the `complete` event. Its data contains the output audio `FileData`.

## Runtime Inputs

- V2 needs source audio and normally a reference voice; anonymization mode ignores the reference.
- Omitted V2 parameters use the app defaults: 30 steps, length 1.0, intelligibility CFG 0.0, similarity CFG 0.7, top-p 0.9, temperature 1.0, repetition penalty 1.0, style conversion off, anonymization off.

## Outputs

- The complete event returns one audio `FileData` object. Prefer its `url` for downloading the converted audio.

## Notes

- Seed-VC converts voice/style/accent; it does not translate speech or select language segments.
