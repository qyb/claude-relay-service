const { PassThrough } = require('stream')

const { consumeSseLines } = require('../src/utils/sseStreamDecoder')

function runDecode(chunks) {
  return new Promise((resolve, reject) => {
    const stream = new PassThrough()
    const lines = []

    consumeSseLines(stream, {
      onLine: (line) => {
        lines.push(line)
      },
      onEnd: () => resolve(lines),
      onError: reject
    })

    for (const chunk of chunks) {
      stream.write(chunk)
    }
    stream.end()
  })
}

describe('consumeSseLines', () => {
  it('handles UTF-8 multi-byte chars split across chunks', async () => {
    const part1 = Buffer.from('data: 你').slice(0, -1)
    const part2 = Buffer.from('data: 你').slice(-1)
    const lines = await runDecode([part1, part2, Buffer.from('\n\n')])

    expect(lines).toEqual(['data: 你', ''])
  })

  it('handles mixed CRLF and LF newlines', async () => {
    const lines = await runDecode([Buffer.from('event: x\r\ndata: 1\n\ndata: 2\r\n\r\n')])

    expect(lines).toEqual(['event: x', 'data: 1', '', 'data: 2', ''])
  })

  it('keeps SSE empty line delimiters', async () => {
    const lines = await runDecode([Buffer.from('data: one\n\ndata: two\n\n')])

    expect(lines).toEqual(['data: one', '', 'data: two', ''])
  })

  it('flushes trailing line without newline on end', async () => {
    const lines = await runDecode([Buffer.from('data: tail')])

    expect(lines).toEqual(['data: tail'])
  })
})
