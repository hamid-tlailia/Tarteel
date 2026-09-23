#!/usr/bin/env node
/**
 * Measures the *voiced* duration of every word in published recitations, for calibration.
 *
 *   CHROMIUM=/path/to/chrome node tools/measure-segments.mjs 78,97,112 > segments.json
 *
 * Why a browser: the recitations are mp3, and a headless Chromium is the mp3 decoder that is
 * always to hand. It fetches the surah audio (download.quranicaudio.com sends
 * `Access-Control-Allow-Origin: *`) and the word-level `segments` from api.qurancdn.com, then
 * trims each segment to the sound inside it.
 *
 * Why trimming matters: the published segments partition the whole surah, so a word's segment
 * runs up to where the next one starts and includes the pause after it — and the last word of
 * an ayah carries the entire breath. Taken raw, those spans put al-Ḥuṣarī's ḥaraka at 559ms and
 * had the app reporting a fault on a correctly held madd. Each row therefore carries both the
 * raw span and the voiced duration at two gates: if a conclusion moves between the gates, the
 * trimming is deciding it and the conclusion is worthless.
 */
import { spawn } from 'node:child_process'

const BIN = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell'
const PORT = Number(process.env.CDP_PORT ?? 9444)
const surahs = (process.argv[2] ?? '78,97,112').split(',').map(Number)
const wanted = (process.argv[3] ?? '').split(',').filter(Boolean)

const proc = spawn(
  BIN,
  [
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${PORT}`,
    ...(process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`, '--proxy-bypass-list=localhost;127.0.0.1'] : []),
    '--ignore-certificate-errors',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  let targets = null
  for (let i = 0; i < 60; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      if (targets.length) break
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((res) => {
      const n = ++id
      pending.set(n, res)
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
    return r.result?.result?.value
  }
  await send('Runtime.enable')
  // A real origin, so the cross-origin fetches below are ordinary CORS rather than opaque.
  await send('Page.navigate', { url: 'https://api.qurancdn.com/api/qdc/audio/reciters?language=ar' })
  await sleep(1500)

  const reciters = (
    await evaluate(`(async () => {
      const r = await (await fetch('https://api.qurancdn.com/api/qdc/audio/reciters?language=ar')).json()
      return r.reciters
        .filter((x) => (x.qirat?.name || '').toLowerCase() === 'hafs')
        .map((x) => ({ id: x.id, name: x.translated_name?.name ?? x.name, style: x.style?.name }))
    })()`)
  ).filter((r) => (wanted.length === 0 ? r.style === 'Murattal' : wanted.includes(String(r.id))))
  process.stderr.write(`reciters: ${reciters.map((r) => `${r.id}:${r.name}`).join(', ')}\n`)

  const rows = []
  for (const reciter of reciters) {
    for (const surah of surahs) {
      const got = await evaluate(`(async () => {
        const meta = await (await fetch('https://api.qurancdn.com/api/qdc/audio/reciters/${reciter.id}/audio_files?chapter=${surah}&segments=true')).json()
        const file = meta.audio_files?.[0]
        if (!file?.audio_url) return { error: 'no audio url' }
        const buf = await (await fetch(file.audio_url)).arrayBuffer()
        const audio = await new OfflineAudioContext(1, 48000, 48000).decodeAudioData(buf)
        const pcm = audio.getChannelData(0)
        const sr = audio.sampleRate
        const frame = Math.round(sr * 0.01)
        const env = []
        for (let i = 0; i + frame <= pcm.length; i += frame) {
          let sum = 0
          for (let j = i; j < i + frame; j++) sum += pcm[j] * pcm[j]
          env.push(Math.sqrt(sum / frame))
        }
        const sorted = [...env].sort((a, b) => a - b)
        const floor = sorted[Math.floor(sorted.length * 0.05)] || 1e-5
        const rows = []
        for (const timing of file.verse_timings ?? []) {
          for (const seg of timing.segments ?? []) {
            if (!Array.isArray(seg) || seg.length < 3) continue
            const [wordIndex, fromMs, toMs] = seg
            const a = Math.max(0, Math.floor(((fromMs / 1000) * sr) / frame))
            const b = Math.min(env.length, Math.ceil(((toMs / 1000) * sr) / frame))
            if (b - a < 2) continue
            let peak = 0
            for (let k = a; k < b; k++) peak = Math.max(peak, env[k])
            const voicedAt = (share) => {
              const gate = Math.max(peak * share, floor * 3)
              let first = -1
              let last = -1
              for (let k = a; k < b; k++) if (env[k] >= gate) { if (first < 0) first = k; last = k }
              return first < 0 ? 0 : (last - first + 1) * 10
            }
            rows.push({
              ayahKey: timing.verse_key,
              wordIndex,
              spanMs: toMs - fromMs,
              voicedMs: voicedAt(0.08),
              voiced3Ms: voicedAt(0.03),
            })
          }
        }
        return { rows, seconds: pcm.length / sr }
      })()`)
      if (!got?.rows) {
        process.stderr.write(`  ${reciter.name} surah ${surah}: ${got?.error ?? 'failed'}\n`)
        continue
      }
      process.stderr.write(`  ${reciter.name} surah ${surah}: ${got.rows.length} words from ${got.seconds.toFixed(0)}s\n`)
      for (const row of got.rows) rows.push({ reciter: reciter.name, surah, ...row })
    }
  }
  process.stdout.write(JSON.stringify(rows))
  process.stderr.write(`\n${rows.length} words measured\n`)
} finally {
  proc.kill('SIGKILL')
}
