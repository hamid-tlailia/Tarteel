import { useCallback, useEffect, useRef, useState } from 'react'
import type { TimedChunk } from './whisper.worker'

export type ModelStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface TranscribeResult {
  text: string
  chunks: TimedChunk[]
}

interface ProgressInfo {
  status: string
  file?: string
  progress?: number
}

/** Loads and drives the Whisper ASR model inside a Web Worker so the UI thread stays smooth.
 * The worker (and its onnxruntime/transformers bundle) is only created when `load()` is called,
 * so simply visiting the practice page doesn't pull in ~600kB of ASR code the user may never use. */
export function useWhisper() {
  const workerRef = useRef<Worker | null>(null)
  const [status, setStatus] = useState<ModelStatus>('idle')
  const [progress, setProgress] = useState(0)
  const [progressLabel, setProgressLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const pendingRef = useRef<{ resolve: (result: TranscribeResult) => void; reject: (err: Error) => void } | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    return () => workerRef.current?.terminate()
  }, [])

  const load = useCallback(() => {
    if (status === 'loading' || status === 'ready') return
    setStatus('loading')
    setError(null)

    const worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (data.type === 'progress') {
        const info: ProgressInfo = data.progress
        if (info.status === 'progress' && typeof info.progress === 'number') {
          setProgress(info.progress)
          setProgressLabel(info.file ?? '')
        }
      } else if (data.type === 'ready') {
        setStatus('ready')
        setProgress(100)
      } else if (data.type === 'result') {
        pendingRef.current?.resolve({ text: data.text as string, chunks: (data.chunks as TimedChunk[]) ?? [] })
        pendingRef.current = null
      } else if (data.type === 'error') {
        setError(data.error)
        setStatus((s) => (s === 'loading' ? 'error' : s))
        pendingRef.current?.reject(new Error(data.error))
        pendingRef.current = null
      }
    }

    worker.postMessage({ type: 'load' })
  }, [status])

  const transcribe = useCallback((audio: Float32Array): Promise<TranscribeResult> => {
    return new Promise((resolve, reject) => {
      const requestId = ++requestIdRef.current
      pendingRef.current = { resolve, reject }
      workerRef.current?.postMessage({ type: 'transcribe', audio, requestId }, [audio.buffer])
    })
  }, [])

  return { status, progress, progressLabel, error, load, transcribe }
}
