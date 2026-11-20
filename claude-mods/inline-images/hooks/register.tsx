import type { Register } from 'claude-code'

const MAX_COLS = 60
const MAX_ROWS = 24
const CACHE = '/tmp/claude-inline-images'

type ImageOut = {
  type: string
  file: { base64: string; type: string; dimensions?: { displayWidth?: number; displayHeight?: number } }
}
type Call = { tool_use_id?: string; tool: string; input: unknown; isErrored: boolean; output?: unknown }

// Base64 PNGs converted from non-PNG images, keyed by source path.
const converted = new Map<string, Promise<string | undefined>>()

function fit(w = 4, h = 3): { columns: number; rows: number } {
  // A terminal cell is roughly twice as tall as it is wide.
  let columns = MAX_COLS
  let rows = Math.round((columns * h) / w / 2)
  if (rows > MAX_ROWS) {
    rows = MAX_ROWS
    columns = Math.round((rows * 2 * w) / h)
  }
  return { columns: Math.max(1, Math.min(255, columns)), rows: Math.max(1, rows) }
}

// A short, filesystem-safe name for a path (FNV-1a).
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

// The picture for one finished image Read, or undefined.
async function picture($: any, Image: any, call: Call) {
  if (call.tool !== 'Read' || call.isErrored) return undefined
  const out = call.output as ImageOut | undefined
  if (!out || out.type !== 'image') return undefined
  const path = (call.input as { file_path?: string })?.file_path
  const d = out.file.dimensions
  const size = fit(d?.displayWidth, d?.displayHeight)

  let source
  if (out.file.type === 'image/png') {
    source = { png: out.file.base64 }
  } else {
    if (!path) return undefined
    if (!converted.has(path)) {
      // Herdr draws image bytes but not image files: convert to PNG, send it as base64.
      const dest = `${CACHE}/${hash(path)}.png`
      const script = 'mkdir -p "$1" && /usr/bin/sips -s format png -Z 1200 "$2" --out "$3" >/dev/null && /usr/bin/base64 -i "$3"'
      converted.set(
        path,
        $.process
          .run(['/bin/sh', '-c', script, 'sh', CACHE, path, dest])
          .then((r: { exitCode: number; stdout: string }) => {
            const b64 = r.stdout.replace(/\s+/g, '')
            return r.exitCode === 0 && b64 ? b64 : undefined
          })
          .catch(() => undefined),
      )
    }
    const png = await converted.get(path)
    if (!png) return undefined
    source = { png }
  }
  return <Image source={source} columns={size.columns} rows={size.rows} alt={`[image: ${path ?? 'image'}]`} />
}

export const register: Register = on => {
  // A standalone Read row, or one unfolded from a group.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'terminal') return row
    const { Box, Image } = $.ui.resolve(e)
    const pic = await picture($, Image, e.props)
    if (!pic) return row
    return (
      <Box flexDirection="column">
        {row}
        <Box paddingLeft={2}>{pic}</Box>
      </Box>
    )
  })

  // A folded group ("Read 2 files, ..."): keep the line, show its images under it.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'terminal' || e.props.isExpanded) return row
    const { Box, Image } = $.ui.resolve(e)
    const pics = (
      await Promise.all(e.props.calls.map(c => picture($, Image, c as Call)))
    ).filter(Boolean)
    if (pics.length === 0) return row
    return (
      <Box flexDirection="column">
        {row}
        {pics.map((p, i) => (
          <Box key={`b${i}`} paddingLeft={2}>
            {p}
          </Box>
        ))}
      </Box>
    )
  })
}
