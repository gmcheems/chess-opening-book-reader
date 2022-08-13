import fs from 'node:fs'
import EventEmitter from 'node:events'
import Opening from './entry.js'
import { Transform } from 'node:stream'

function extract_value(text) {
  let match = text.match(/"(.+)"/)
  return match ? match[1] : ''
}

class ECOStream extends Transform {
  constructor() {
    super({ readableObjectMode: true })
    this._data = ''
    this._lines = []
    this.in_comment = false
    this.in_pgn = false
    this.in_record = false
    this.comment = ''
    this.current_record = false
  }
  _flush(callback) {
    this._make_records_from_lines()
    callback()
  }
  _transform(chunk, encoding, callback) {
    let data = chunk.toString()
    let lines = data.split(/\n/m)
    if (this._lines.length > 0) {
      console.log('append to last line')
      this._lines[this.lines.length - 1] += lines.shift()
    }
    for (let line of lines) {
      this._lines.push(line)
    }
    this._make_records_from_lines()
    callback()
  }
  _make_records_from_lines() {
    let length = this._lines.length
    for (let index = 0; index < length; index++) {
      let line = this._lines.shift()
      if (line.startsWith('{')) {
        this.in_comment = true
      }
      if (line.startsWith('}')) {
        this.emit('has_comment', this.comment)
        this.in_comment = false
      }
      if (this.in_comment && line !== '{') {
        this.comment = this.comment + line + '\n'
      }
      if (line.startsWith('[ECO')) {
        if (this.current_record) {
          this.current_record.pgn = this.current_record.pgn.trim()
          this.push(this.current_record)
        }
        this.current_record = new Opening()
        this.current_record.eco_code = extract_value(line)
      } else if (line.startsWith('[Opening')) {
        this.current_record.name = extract_value(line)
      } else if (line.startsWith('[Variation')) {
        this.current_record.variation = extract_value(line)
      } else if (line.startsWith('1.')) {
        this.in_pgn = true
        this.current_record.pgn = line
      } else if (this.in_pgn && line) {
        this.current_record.pgn = this.current_record.pgn + ' ' + line
      } else if (this.in_pgn && !line) {
        this.in_pgn = false
      }
    }
  }
}

class Eco extends EventEmitter {
  constructor() {
    super()
    this.loaded = false
    this.comment = ''
    this.entries = []
    this.stream = new ECOStream()
  }
  load_stream(stream) {
    this.stream.on('finish', () => {
      this.loaded = true
      this.emit('loaded')
    })
    this.stream.on('data', (entry) => {
      this.entries.push(entry)
    })
    stream.pipe(this.stream)
  }
  load_default() {
    this.load_stream(fs.createReadStream(__dirname + '/eco.pgn'))
  }
  find(pgn) {
    if (!this.loaded) {
      throw new Error('wait for loaded event')
    }
    let best_match
    for (let record of this.entries) {
      let r_pgn = record.pgn.slice(0, Math.max(0, record.pgn.indexOf('*')))
      if (pgn.includes(r_pgn)) {
        best_match =
          best_match && record.pgn.length > best_match.pgn.length
            ? record
            : record
      }
    }
    return best_match
  }
}

export default Eco
