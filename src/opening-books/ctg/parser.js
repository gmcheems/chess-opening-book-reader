import EventEmitter from 'events'
import { Chess } from 'chess.js'

import {
  board,
  pad_number_string,
  // debug_buffer_to_string,
} from '../../utils.js'
import {
  piece_encoding,
  piece_encoding_black,
  flip_ep_column,
  ep_mask,
  castle_mask,
} from './encoding.js'
import CTGMoveService from './moves.js'
import CTGEntry from './entry.js'

const chess = new Chess()
const chess_black = new Chess()
const files = board.FILES
const ranks = board.RANKS
const board_index = board.BOARD_INDEX
const flip_board = board.FLIP_BOARD
const mirror_file = board.MIRROR_FILE
const moveService = new CTGMoveService()

function read_24(dataview, start) {
  let byte1 = dataview.getUint8(start)
  let byte2 = dataview.getUint8(start + 2)
  let byte3 = dataview.getUint8(start + 4)
  return (byte1 << 16) + (byte2 << 8) + byte3
}

// Based on notes from http://rybkaforum.net/cgi-bin/rybkaforum/topic_show.pl?tid=2319
// https://web.archive.org/web/20210129162445/http://rybkaforum.net/cgi-bin/rybkaforum/topic_show.pl?tid=2319
export class CTGParser extends EventEmitter {
  stopProcessing = false

  constructor() {
    super()
    this.on('stop', () => {
      this.stopProcessing = true
    })
  }

  async parse({ buffer, wait = true }) {
    this.stopProcessing = false
    let remainder = buffer.byteLength % 4096
    if (remainder > 0 && buffer.byteLength < 4096) {
      throw new Error('Invalid CTG File (file not a factor of 4096)')
    }

    let dataview = new DataView(buffer)
    let number_pages = Number.parseInt(buffer.byteLength / 4096)
    // let number_of_games = dataview.getUint32(28)

    let batchEntries = []

    let batchSize = 1000,
      waitTime = 100

    if (number_pages > 1000) {
      batchSize = 5000
      waitTime = 200
    }
    if (number_pages > 10_000) {
      batchSize = 10_000
      waitTime = 500
    }

    // start at page 1 to discard first 4096 bytes as it only contains metadata
    for (let page_number = 1; page_number < number_pages; page_number++) {
      if (this.stopProcessing) {
        break
      }
      this.process_page(buffer, page_number, dataview, batchEntries)

      if (batchEntries.length >= batchSize) {
        this.emit('batch', batchEntries)
        this.emit('progress', page_number / number_pages)
        batchEntries = []

        if (wait) {
          await new Promise((r) => setTimeout(r, waitTime))
        }
      }
    }

    if (batchEntries.length > 0) {
      this.emit('batch', batchEntries)
    }
  }

  process_page(buffer, page_number, dataView, batchEntries) {
    let page_start = page_number * 4096
    let number_of_positions = dataView.getUint16(page_start)
    let bytes_in_page = dataView.getUint16(page_start + 2)
    let page = buffer.slice(page_start, page_start + bytes_in_page)
    let pageView = new DataView(page)
    this.record_start = 4
    this.last_record_start = 4

    for (let pos = 0; pos < number_of_positions; pos++) {
      const [entry, entry_black] = this.process_entry(
        pos,
        page_number,
        page,
        pageView,
      )

      batchEntries.push(entry, entry_black)
    }
  }

  process_entry(pos, page_number, page, pageView) {
    this.entry_num++
    let entry = new CTGEntry()
    let entry_black = new CTGEntry('b')
    entry.entry_num = this.entry_num
    entry.page = page_number
    entry.record_start = this.record_start
    entry.pos = pos
    entry_black.entry_num = this.entry_num
    entry_black.page = page_number
    entry_black.record_start = this.record_start
    entry_black.pos = pos
    this.last_record_start = this.record_start
    let header_byte = pageView.getUint8(this.record_start)
    // eslint-disable-next-line unicorn/number-literal-case
    let position_length = header_byte & 0x1f
    let en_passant = header_byte & 0x20
    let castling = header_byte & 0x40

    // Could happen if loading wrong file type
    if (!header_byte) {
      // debug_buffer_to_string(
      //   page.slice(this.record_start - 3, this.record_start + 3),
      // )
      throw new Error('Invalid header byte')
    }

    // console.log(pad_number_string(header_byte.toString(2), 8));
    entry.position_length = position_length
    // console.log("POSITION LENGTH", position_length);
    entry.has_en_passant = en_passant
    entry.has_castling = castling
    entry_black.position_length = position_length
    entry_black.has_en_passant = en_passant
    entry_black.has_castling = castling
    let p1 = this.record_start + 1
    let p2 = p1 + position_length
    let position_buffer = page.slice(p1, p2)
    let position_view = new Uint8Array(position_buffer)
    let binary_string = ''
    for (const element of position_view) {
      binary_string += pad_number_string(element.toString(2), 8)
    }
    entry.encoded_position = binary_string
    entry_black.encoded_position = binary_string
    let board = []
    let board_black = []
    let string_position = 0
    let max = 6
    let rank = 0
    let file = 0
    let black_is_mirrored = false
    chess.clear()
    chess_black.clear()
    POSITION_LOOP: for (
      let board_position = 0;
      board_position < 64;
      board_position++
    ) {
      for (let string_length = 1; string_length <= max; string_length++) {
        let eval_string = binary_string.slice(
          string_position,
          string_position + string_length,
        )
        for (let piece_code of Object.keys(piece_encoding)) {
          if (String(eval_string) === String(piece_code)) {
            if (rank == 8) {
              file++
              rank = 0
            }
            let algebraic_position = files[file] + '' + ranks[rank]
            let black_position = flip_board[algebraic_position]
            if (
              piece_encoding[String(piece_code)] &&
              piece_encoding[String(piece_code)].txt !== ' '
            ) {
              chess.put(piece_encoding[String(piece_code)], algebraic_position)
              if (
                piece_encoding_black[String(piece_code)].txt == 'K' &&
                /[a-d]\d/.test(black_position) &&
                !entry.has_castling
              ) {
                black_is_mirrored = true
              }
              chess_black.put(
                piece_encoding_black[String(piece_code)],
                black_position,
              )
            }

            board.push({
              piece: piece_encoding[String(piece_code)],
              position: algebraic_position,
            })

            board_black[board_index[black_position]] = {
              piece: piece_encoding_black[String(piece_code)],
              position: black_position,
            }

            string_position += String(piece_code).length
            string_length = 1
            rank++
            continue POSITION_LOOP
          }
        }
      }
    }

    if (black_is_mirrored) {
      entry_black.is_mirrored = true
      chess_black.clear()
      let temporary_board_black = []
      entry_black.has_castling = 0
      for (let position of board_black) {
        let pos_elements = position.position.split('')
        pos_elements[0] = mirror_file[pos_elements[0]]
        position.position = pos_elements.join('')
        let updated = board_index[position.position]
        temporary_board_black[updated] = position
        if (position.piece.txt != ' ') {
          chess_black.put(position.piece, position.position)
        }
      }
      board_black = temporary_board_black
    }

    // entry.board = board
    // entry_black.board = board_black
    this.record_start += position_length
    if (en_passant || castling) {
      let ep_castle = pageView.getUint8(this.record_start - 1)
      let ep_value = ep_castle & ep_mask
      ep_value = ep_value >> 5
      entry.en_passant_data = ep_value
      entry_black.en_passant_data = black_is_mirrored
        ? flip_ep_column[ep_value]
        : ep_value
      let castle_value = ep_castle & castle_mask
      castle_value = castle_value >> 1
      entry.castling_data = castle_value
      entry_black.castling_data = castle_value
    }
    entry.setFen(chess.fen())
    entry_black.setFen(chess_black.fen())
    let book_moves_size = pageView.getUint8(this.record_start)
    let number_book_moves = 0
    if (book_moves_size > 0) {
      number_book_moves = (book_moves_size - 1) / 2
    }
    let move_start = this.record_start + 1
    for (let m = 0; m < number_book_moves; m++) {
      let book_move = pageView.getUint8(move_start + m * 2)
      let book_annotation = pageView.getUint8(move_start + m * 2 + 1)
      let move_and_analysis = moveService.decode_move(
        book_move,
        book_annotation,
        board,
      )
      let move_and_analysis_black = moveService.decode_move(
        book_move,
        book_annotation,
        board_black,
        'b',
        black_is_mirrored,
      )

      // Only add the moves if they are not null
      if (move_and_analysis) {
        entry.book_moves.push(move_and_analysis)
      }
      if (move_and_analysis_black) {
        entry_black.book_moves.push(move_and_analysis_black)
      }
    }
    this.record_start += book_moves_size
    let number_games = read_24(pageView, this.record_start)
    entry.total_games = number_games
    this.record_start += 3
    let number_white_wins = read_24(pageView, this.record_start)
    entry.white_wins = number_white_wins
    entry_black.black_wins = number_white_wins
    this.record_start += 3
    let number_black_wins = read_24(pageView, this.record_start)
    entry.black_wins = number_black_wins
    entry_black.white_wins = number_black_wins
    this.record_start += 3
    let number_draws = read_24(pageView, this.record_start)
    entry.draws = number_draws
    entry_black.draws = entry.draws
    this.record_start += 3
    let unknown_integer = pageView.getUint32(this.record_start)
    entry.unknown1 = unknown_integer
    this.record_start += 4
    let rating1_number_games = read_24(pageView, this.record_start)
    this.record_start += 3
    let rating1_rating_total = pageView.getUint32(this.record_start)
    let rating1_rating = rating1_rating_total / rating1_number_games
    entry.ratings.push({
      games: rating1_number_games,
      rating: rating1_rating,
      total_ratings: rating1_rating_total,
    })
    this.record_start += 4
    let rating2_number_games = read_24(pageView, this.record_start)
    this.record_start += 3
    let rating2_rating_total = pageView.getUint32(this.record_start)
    this.record_start += 4
    let rating2_rating = rating2_rating_total / rating2_number_games
    entry.ratings.push({
      games: rating2_number_games,
      rating: rating2_rating,
      total_ratings: rating2_rating_total,
    })
    entry_black.ratings = entry.ratings
    let recommendation = pageView.getUint8(this.record_start)
    entry.recommendation = moveService.decode_analysis(recommendation)
    entry_black.recommendation
    this.record_start += 1
    let unknown2 = pageView.getUint8(this.record_start)
    entry.unknown2 = unknown2
    this.record_start += 1
    let commentary = pageView.getUint8(this.record_start)
    entry.commentary = moveService.decode_analysis(commentary)
    entry_black.commentary = entry.commentary
    this.record_start += 1
    let statistics_size = 12 + 4 + 14 + 3 //stats, unknown, ratings, recommendation, commentary;
    let record_offset = position_length + book_moves_size + statistics_size
    entry.record_offset = record_offset
    entry_black.record_offset = record_offset
    // console.log(entry.record_start, entry.record_offset);
    return [entry, entry_black]
  }
}
