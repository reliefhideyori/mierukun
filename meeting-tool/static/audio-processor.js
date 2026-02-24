/**
 * AudioWorklet プロセッサ - 生 PCM キャプチャ & 16kHz ダウンサンプル
 *
 * ブラウザのネイティブサンプルレート（44100 or 48000Hz）から
 * Whisper が期待する 16000Hz にリサンプルして 3 秒分ずつ送信する。
 *
 * ※ WebM チャンク方式の「Invalid data」問題を根本解決するため
 *    生 Float32 PCM を直接送り、バックエンドで WAV 化する。
 */
class MeetingAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const nativeRate     = sampleRate;          // AudioContext のレート (e.g. 44100 / 48000)
    const targetRate     = 16000;               // Whisper の期待レート
    this._ratio          = nativeRate / targetRate;
    this._chunkOutSamples = targetRate * 3;     // 3 秒 × 16000 = 48000 出力サンプル
    this._chunkInSamples  = Math.ceil(this._chunkOutSamples * this._ratio);

    // 入力バッファ（ネイティブレート）
    this._inputBuf    = new Float32Array(this._chunkInSamples + 256);
    this._inputOffset = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    let srcIdx = 0;
    while (srcIdx < input.length) {
      const space   = this._chunkInSamples - this._inputOffset;
      const toCopy  = Math.min(space, input.length - srcIdx);

      this._inputBuf.set(input.subarray(srcIdx, srcIdx + toCopy), this._inputOffset);
      this._inputOffset += toCopy;
      srcIdx           += toCopy;

      // 必要サンプル分溜まったら 16kHz にダウンサンプルして送信
      if (this._inputOffset >= this._chunkInSamples) {
        const out = this._downsample(this._inputBuf, this._chunkInSamples);
        // transferable として送信（コピーなし・低レイテンシ）
        this.port.postMessage(out.buffer, [out.buffer]);
        this._inputOffset = 0;
      }
    }

    return true;
  }

  /**
   * 平均値ダウンサンプラー（speech 品質には十分）
   */
  _downsample(input, inputLen) {
    const ratio  = this._ratio;
    const outLen = this._chunkOutSamples;
    const out    = new Float32Array(outLen);

    if (Math.abs(ratio - 1.0) < 0.001) {
      // レートが同じなら直接コピー
      out.set(input.subarray(0, outLen));
    } else {
      for (let i = 0; i < outLen; i++) {
        const start = Math.floor(i * ratio);
        const end   = Math.min(Math.floor((i + 1) * ratio), inputLen);
        let sum = 0;
        for (let j = start; j < end; j++) sum += input[j];
        out[i] = sum / (end - start);
      }
    }

    return out;
  }
}

registerProcessor('meeting-audio-processor', MeetingAudioProcessor);
