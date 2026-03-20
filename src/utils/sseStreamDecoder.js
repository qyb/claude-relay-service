const { StringDecoder } = require('string_decoder')

function consumeSseLines(stream, handlers = {}) {
  const { onChunk, onLine, onEnd, onError } = handlers
  const decoder = new StringDecoder('utf8')
  let buffer = ''

  const emitLine = (line) => {
    if (typeof onLine === 'function') {
      onLine(line)
    }
  }

  const flushDecodedText = (text) => {
    if (!text) {
      return
    }

    buffer += text
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      let line = buffer.slice(0, newlineIndex)
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      emitLine(line)
      buffer = buffer.slice(newlineIndex + 1)
      newlineIndex = buffer.indexOf('\n')
    }
  }

  stream.on('data', (chunk) => {
    try {
      if (typeof onChunk === 'function') {
        onChunk(chunk)
      }
      const decoded = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      flushDecodedText(decoded)
    } catch (error) {
      if (typeof onError === 'function') {
        onError(error)
      }
    }
  })

  stream.on('end', async () => {
    try {
      flushDecodedText(decoder.end())
      if (buffer.length > 0) {
        const tailLine = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
        emitLine(tailLine)
        buffer = ''
      }
      if (typeof onEnd === 'function') {
        await onEnd()
      }
    } catch (error) {
      if (typeof onError === 'function') {
        onError(error)
      }
    }
  })

  stream.on('error', (error) => {
    if (typeof onError === 'function') {
      onError(error)
    }
  })
}

module.exports = {
  consumeSseLines
}
