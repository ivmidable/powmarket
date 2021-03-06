const log = require("debug")("pow:state_machine");

import Hummingbird from "hummingbird-bitcoin"

import { connect, good, dupe } from "./db"

import * as helpers from "./helpers"
import * as data from "./data"

import bsv from "bsv"

const Opcode = bsv.Opcode;

const utxos = new Set();

const PUZZLE_TYPE_21E8MINER = "21e8miner";
const PUZZLE_TYPE_BRENDANLEE = "brendanlee";
const PUZZLE_TYPE_BOOST = "boostpow";

const BITCOM_PROTOCOL_BITSV = "1L8eNuA8ToLGK5aV4d5d9rXUAbRZUxKrhF";

const CONTENT_TYPE_UNKNOWN = "unknown";
const CONTENT_TYPE_META = "meta";
const CONTENT_TYPE_BITSV = "bitsv";

function getContentType(tx) {
    if (tx.out[0].s6 === BITCOM_PROTOCOL_BITSV || tx.out[0].s2 === BITCOM_PROTOCOL_BITSV) {
        return CONTENT_TYPE_BITSV;
    } else if (tx.out[0].s2 === "meta") {
        return CONTENT_TYPE_META;
    }
    return CONTENT_TYPE_UNKNOWN;
}

function getContentTXID(tx) {
    const content_type = getContentType(tx);
    if (content_type == CONTENT_TYPE_BITSV) {
        if (tx.out[0].s11 === "content") { // TODO: should parse MAP data and use that
            return tx.tx.h;
        } else if (tx.out[0].s7 === "receipt" && tx.out[0].s8 === "txid") {
            return tx.out[0].s9;
        } else {
            log(`unable to find bit.sv content_txid for ${JSON.stringify(tx, null, 4)}`);
        }
    }

    return null;
}

function is21e8MinerScript(script) {
    return !!(
        script.chunks.length === 12 &&
        script.chunks[0].buf &&
        script.chunks[0].buf.length >= 1 &&
        script.chunks[1].buf &&
        script.chunks[1].buf.length >= 1 &&
        script.chunks[2].opcodenum === Opcode.OP_SIZE &&
        script.chunks[3].opcodenum === Opcode.OP_4 &&
        script.chunks[4].opcodenum === Opcode.OP_PICK &&
        script.chunks[5].opcodenum === Opcode.OP_SHA256 &&
        script.chunks[6].opcodenum === Opcode.OP_SWAP &&
        script.chunks[7].opcodenum === Opcode.OP_SPLIT &&
        script.chunks[8].opcodenum === Opcode.OP_DROP &&
        script.chunks[9].opcodenum === Opcode.OP_EQUALVERIFY &&
        script.chunks[10].opcodenum === Opcode.OP_DROP &&
        script.chunks[11].opcodenum === Opcode.OP_CHECKSIG
    );
}

function debugScript(script) {
    try {
        console.log(script.chunks.length, 12, "CHUNKS", (script.chunks.length == 12));
        console.log(script.chunks[0].buf, 1, !!script.chunks[0].buf);
        console.log(script.chunks[0].buf.length, 1, "BUF0", (script.chunks[0].buf.length >= 1));
        console.log(script.chunks[1].buf, 1, !!script.chunks[1].buf);
        console.log(script.chunks[1].buf.length, 1, "BUF1", (script.chunks[1].buf.length >= 1));

        console.log(script.chunks[2].opcodenum, Opcode.OP_SIZE, (script.chunks[2].opcodenum == Opcode.OP_SIZE));
        console.log(script.chunks[3].opcodenum, Opcode.OP_4, (script.chunks[3].opcodenum == Opcode.OP_4));
        console.log(script.chunks[4].opcodenum, Opcode.OP_PICK, (script.chunks[4].opcodenum == Opcode.OP_PICK));
        console.log(script.chunks[5].opcodenum, Opcode.OP_SHA256, (script.chunks[5].opcodenum == Opcode.OP_SHA256));
        console.log(script.chunks[6].opcodenum, Opcode.OP_SWAP, (script.chunks[6].opcodenum == Opcode.OP_SWAP));
        console.log(script.chunks[7].opcodenum, Opcode.OP_SPLIT, (script.chunks[7].opcodenum == Opcode.OP_SPLIT));
        console.log(script.chunks[8].opcodenum, Opcode.OP_DROP, (script.chunks[8].opcodenum == Opcode.OP_DROP));
        console.log(script.chunks[9].opcodenum, Opcode.OP_EQUALVERIFY, (script.chunks[9].opcodenum == Opcode.OP_EQUALVERIFY));
        console.log(script.chunks[10].opcodenum, Opcode.OP_DROP, (script.chunks[10].opcodenum == Opcode.OP_DROP));
        console.log(script.chunks[11].opcodenum, Opcode.OP_CHECKSIG, (script.chunks[11].opcodenum == Opcode.OP_CHECKSIG));
    } catch (e) {
        console.log("err while debugging");
    }
}

function isCoinguruStyleScript(script) {
    return !!(
        script.chunks.length >= 13 &&
        script.chunks[0].buf &&
        script.chunks[0].buf.length >= 1 &&
        script.chunks[1].buf &&
        script.chunks[1].buf.length > 1 &&
        script.chunks[2].opcodenum === Opcode.OP_SIZE &&
        script.chunks[3].opcodenum === Opcode.OP_4 &&
        script.chunks[4].opcodenum === Opcode.OP_PICK &&
        script.chunks[5].opcodenum === Opcode.OP_SHA256 &&
        script.chunks[6].opcodenum === Opcode.OP_SWAP &&
        script.chunks[7].opcodenum === Opcode.OP_SPLIT &&
        script.chunks[8].opcodenum === Opcode.OP_DROP &&
        script.chunks[9].opcodenum === Opcode.OP_EQUALVERIFY &&
        script.chunks[10].opcodenum === Opcode.OP_DROP &&
        script.chunks[11].opcodenum === Opcode.OP_CODESEPARATOR &&
        script.chunks[12].opcodenum === Opcode.OP_CHECKSIG
    );
}

function isPuzzle(script) {
    return is21e8MinerScript(script) || isCoinguruStyleScript(script);
}

function getPuzzleType(script) {
    if (is21e8MinerScript(script)) {
        return PUZZLE_TYPE_21E8MINER;
    }

    if (isCoinguruStyleScript(script)) {
        return PUZZLE_TYPE_BRENDANLEE;
    }
}

export default class POWMarketStateMachine {
    async onstart() {
        this.db = await connect();

        const pendingMagicNumbers = await this.db.collection("magicnumbers").find({ mined: false }).toArray();
        for (const magicnumber of pendingMagicNumbers) {
            const utxo = `${magicnumber.txid}:${magicnumber.vout}`;
            log(`adding target for ${magicnumber.target} at utxo ${utxo}`);
            utxos.add(utxo);
        }
    }

    async ontransaction(tx) {
        const confirmed = !!tx.blk;
        const created_at = Math.floor(tx.blk ? tx.blk.t : Date.now() / 1000);

        // log(tx.tx.h);

        for (const input of tx.in) {
            const txid = input.e.h;
            const vout = input.e.i;
            const utxo = `${txid}:${vout}`;

            if (utxos.has(utxo)) {
                const asm = input.str;
                const script = bsv.Script.fromASM(asm);
                const presig = script.chunks[0].buf;
                const magicnumber = bsv.crypto.Hash.sha256(presig).toString("hex");

                log(`🌟 r-puzzle mined ${magicnumber} at ${tx.tx.h}`);

                const result = await this.db.collection("magicnumbers").findOne({ txid });
                if (!result) {
                    throw new Error(`error while processing r-puzzle solution, couldn't find ${txid}`);
                }

                const bsvusd = await helpers.bsvusd();
                const mined_price = helpers.satoshisToDollars(result.value, bsvusd);

                const pow = helpers.countpow(magicnumber, result.target);
                let power = Math.pow(10, pow);

                if (result.emoji && data.isBadEmoji(result.emoji)) {
                    power = power * -1;
                }

                const response = await this.db.collection("magicnumbers").updateOne({ txid }, {
                    "$set": {
                        mined: true,
                        power,
                        mined_at: created_at,
                        mined_price,
                        magicnumber,
                        mined_txid: tx.tx.h,
                        mined_address: input.e.a,
                    }
                });

                if (!good(response)) {
                    console.log(response);
                    throw new Error(`error while processing r-puzzle solution ${tx.tx.h}`);
                }

                utxos.delete(utxo);
            }
        }

        let vout = 0;
        for (const out of tx.out) {
            const script = bsv.Script.fromASM(out.str); // TODO: slow
            const type = getPuzzleType(script);
            if (type) {
                const content_type = getContentType(tx);
                const content_txid = getContentTXID(tx);

                const value = out.e.v;
                const txid = tx.tx.h;
                const parts = out.str.split(" "); // TODO: use script
                const hash = parts[0];
                const target = parts[1];

                const emoji = data.isEmojiMagicNumber(target);

                try {
                    const obj = {
                        type,
                        vout,
                        from: tx.in[0].e.a,
                        value,
                        confirmed,
                        hash,
                        target,
                        mined: false,
                        created_at,
                    };

                    if (content_type && content_type !== CONTENT_TYPE_UNKNOWN) {
                        obj["content_type"] = content_type;
                    }

                    if (content_txid) {
                        obj["content_txid"] = content_txid;
                    }

                    if (emoji) {
                        obj.emoji = String.fromCodePoint(parseInt(emoji, 16));
                    }

                    if (this.updating) {
                        await this.db.collection("magicnumbers").updateOne({ txid }, {"$set": obj });
                    } else {
                        obj["txid"] = txid;
                        await this.db.collection("magicnumbers").insertOne(obj);
                    }

                    const utxo = `${txid}:${vout}`;
                    if (confirmed) {
                        log(`inserted confirmed magic number into the pool ${txid}`);
                    } else {
                        log(`inserted new magic number into the pool ${txid}`);
                    }

                    utxos.add(utxo);
                } catch (e) {
                    if (dupe(e, ["txid"])) {
                        log(`already added ${tx.tx.h}`);

                        if (confirmed) {
                            await this.db.collection("magicnumbers").updateOne({ txid }, {
                                "$set": {
                                    confirmed: true
                                }
                            });
                        }
                    } else {
                        throw e;
                    }
                }
            }

            vout += 1;
        }

        return true;
    }

    async onrealtime() {
        log("block processing has caught up");
    }
}

if (require.main === module) {
    const hummingbird = new Hummingbird({
        rpc: { host: process.env.RPC_HOST, user: process.env.RPC_USER, pass: process.env.RPC_PASS },
        peer: { host: process.env.PEER_HOST },
        from: 624058,
        state_machines: [
            new POWMarketStateMachine(),
        ],
    });

    hummingbird.start();
}
