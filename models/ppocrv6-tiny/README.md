# PP-OCRv6 tiny — text recognition

The second recogniser of PunktScan: PaddleOCR's PP-OCRv6 tiny recognition model, exported to ONNX
by PaddlePaddle.

- Source: <https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_tiny_rec_onnx_infer.tar>
- Files: `rec.onnx` is `inference.onnx` from that archive, unchanged. `dict.json` is the
  `PostProcess.character_dict` list from its `inference.yml` (CTC decoding: index 0 is the blank,
  index _i_ is `dict[i - 1]`).
- SHA-256 of `rec.onnx`: see `scripts/build.mjs`, which checks it.
- Licence: Apache License 2.0 (PaddleOCR, Copyright PaddlePaddle Authors).

Input: one text line, grey copied to 3 channels, height 48, width ≥ 320 (padded),
`(pixel / 255 − 0.5) / 0.5`. Output: per-step class probabilities, decoded greedily.
