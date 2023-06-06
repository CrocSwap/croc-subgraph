// Import basic data types
import { BigInt, Bytes, ByteArray, Address, BigDecimal, ethereum, crypto, dataSource } from "@graphprotocol/graph-ts"

// Import interfaces for call handlers
import { SwapCall } from "../generated/CrocSwapDex/CrocSwapDex"
import { UserCmdCall as HotProxyUserCmdCall } from "../generated/HotProxy/HotProxy"
import { UserCmdCall as ColdPathUserCmdCall, ProtocolCmdCall } from "../generated/ColdPath/ColdPath"
import { UserCmdCall as WarmPathUserCmdCall } from "../generated/WarmPath/WarmPath"
import { MintRangeCall, MintAmbientCall, BurnRangeCall, BurnAmbientCall, SweepSwapCall } from "../generated/MicroPaths/MicroPaths"
import { UserCmdCall as KnockoutUserCmdCall } from "../generated/KnockoutLiqPath/KnockoutLiqPath"

// Import interfaces for events that are used to replace call handlers for networks that don't support Parity tracing
import { CrocSwap } from "../generated/CrocSwapDex/CrocSwapDex"
import { CrocHotCmd } from "../generated/HotProxy/HotProxy"
import { CrocColdCmd, CrocColdProtocolCmd } from "../generated/ColdPath/ColdPath"
import { CrocWarmCmd } from "../generated/WarmPath/WarmPath"
import { CrocMicroMintAmbient, CrocMicroMintRange, CrocMicroBurnAmbient, CrocMicroBurnRange, CrocMicroSwap } from "../generated/MicroPaths/MicroPaths"
import { CrocKnockoutCmd } from "../generated/KnockoutLiqPath/KnockoutLiqPath"

// Import interfaces for the KnockoutCross event
import { CrocKnockoutCross } from "../generated/KnockoutCounter/KnockoutCounter"
import { FeeChange, KnockoutCross, LatestIndex, LiquidityChange, Pool, Swap, UserBalance } from "../generated/schema"

/***************************** DATA MANIPULATION *****************************/
// Conversions between different data types, unpacking packed data, etc.

// Swaps the endianness of an i32
function swapEndianI32(x: i32): i32 {
  return ((x & 0xFF) << 24)
   | ((x & 0xFF00) << 8)
   | ((x >> 8) & 0xFF00)
   | ((x >> 24) & 0xFF)
}

// Converts a Q64.64 fixed-point number in BigInt format to a floating-point BigDecimal
export function fixedToFloatingPoint(x: BigInt): BigDecimal {
  return x.times(x).divDecimal(new BigDecimal(BigInt.fromI32(2).pow(128)))
}

// Performs the equivalent of Solidity's abi.encode(...) on an array of values
export function encodeArray(arr: Array<ethereum.Value>): Bytes {
  const tuple = ethereum.Value.fromTuple(changetype<ethereum.Tuple>(arr))
  return ethereum.encode(tuple)!
}

// Left-pads a hex string with 0s until it's length 64 and converts into a Bytes array
export function leftPadHexString(x: string): Bytes {
  return Bytes.fromHexString(x.padStart(64, "0"))
}

// Converts a BigInt to a 64-bit Bytes array
export function convertBigIntToBytes(x: BigInt): Bytes {
  return leftPadHexString(x.toHex())
}

// Converts a big-endian i32 into a little-endian 64-bit Bytes array
export function convertI32ToBytes(x: i32): Bytes {
  return leftPadHexString(ByteArray.fromI32(swapEndianI32(x)).toHex())
}

// Converts a boolean into a 64-bit Bytes array representing either 1 (true) or 0 (false)
export function convertBooleanToBytes(x: boolean): Bytes {
  return convertI32ToBytes(x ? 1 : 0)
}

// Given bytedata, decodes it into separate parameters based on a specified function signature
export function decodeAbi(data: Bytes, signature: string): ethereum.Tuple {
  return ethereum.decode(signature, data)!.toTuple()
}

/******************************* OBJECT HASHING ******************************/
// Generates unique hashes corresponding to different types of entities (pools,
// etc.) that are typically just a bunch of variables concatenated or packed
// together.

// Returns the unique pool hash corresponding to a base token, quote token, and pool index
export function getPoolHash(base: Address, quote: Address, poolIdx: BigInt): Bytes {
  const tupleArray: Array<ethereum.Value> = [
    ethereum.Value.fromAddress(base),
    ethereum.Value.fromAddress(quote),
    ethereum.Value.fromUnsignedBigInt(poolIdx)
  ]
  const encoded = encodeArray(tupleArray)
  return changetype<Bytes>(crypto.keccak256(encoded))
}

// Generates unique hash for a CrocKnockoutCross event
export function getKnockoutCrossHash(block: BigInt, transaction: Bytes, poolHash: Bytes, tick: i32, isBid: boolean, pivotTime: BigInt, feeMileage: BigInt): Bytes {
  return convertBigIntToBytes(block).concat(transaction).concat(poolHash).concat(convertI32ToBytes(tick)).concat(convertBooleanToBytes(isBid)).concat(convertBigIntToBytes(pivotTime)).concat(convertBigIntToBytes(feeMileage))
}

// Generates unique hash for a UserBalance object denoting that a given user has interacted with a given token
export function getUserBalanceHash(user: Address, token: Address): Bytes {
  return user.concat(token)
}

export function getLatestIndexID(entityType: String, transaction: Bytes): Bytes {
  const tupleArray: Array<ethereum.Value> = [
    ethereum.Value.fromString(entityType.toString()),
    ethereum.Value.fromBytes(transaction)
  ]
  const encoded = encodeArray(tupleArray)
  return changetype<Bytes>(crypto.keccak256(encoded))
}

/************************* UNIQUE EVENT ID GENERATION ************************/
// Any given event (e.g. a liquidity addition) might happen multiple times
// in a given transaction, so to assign a unique identifier to each event,
// we need to concatenate a transaction hash with a unique "call index" which
// increments upward from zero for every unique pair of (event/entity type,
// transaction hash). These functions handle the bookkeeping for retrieval
// of unique identifiers constructed in this way.

export function getUniqueCallID(transaction: Bytes, callIndex: i32): Bytes {
  return transaction.concat(convertI32ToBytes(callIndex))
}

export function getNextCallIndex(entityType: String, transaction: Bytes): i32 {
  const latestIndexID = getLatestIndexID(entityType, transaction)
  const latestIndex = LatestIndex.load(latestIndexID)
  if (latestIndex === null) {
    const latestIndex_ = new LatestIndex(latestIndexID)
    latestIndex_.callIndex = -1
    latestIndex_.save()
    return 0
  } else {
    return latestIndex.callIndex + 1
  }
}

export function saveCallIndex(entityType: String, transaction: Bytes, callIndex: i32): void {
  const latestIndex = LatestIndex.load(getLatestIndexID(entityType, transaction))!
  latestIndex.callIndex = callIndex
  latestIndex.save()
}

/********* GENERIC HELPERS FOR HANDLING COMMON ENTITY MANIPULATIONS **********/

// Given a set of liquidity pool parameters (base token, quote token,
// pool index), logs a corresponding Pool entity
export function createPool(base: Address, quote: Address, poolIdx: BigInt): void {
  const poolHash = getPoolHash(base, quote, poolIdx)
  if (Pool.load(poolHash) === null) {
    const pool = new Pool(poolHash)
    pool.base = base
    pool.quote = quote
    pool.poolIdx = poolIdx
    pool.save()
  }
}

// Handles liquidity modification (additions, burns, mints) via
// LiquidityChange (per-transaction) entities
export function modifyLiquidity(transaction: Bytes, userAddress: Address, blockNumber: BigInt, timestamp: BigInt, poolHash: Bytes, positionType: string, changeType: string, bidTick: i32, askTick: i32, isBid: boolean, liq: BigInt | null, baseFlow: BigInt | null, quoteFlow: BigInt | null, callSource: string, pivotTime: BigInt | null): void {
  // Get unique entity ID
  const entityType = "liquidityChange"
  const callIndex = getNextCallIndex(entityType, transaction)

  // Create LiquidityChange entity corresponding to the minting or burning transaction
  const liquidityChange = new LiquidityChange(getUniqueCallID(transaction, callIndex))
  liquidityChange.transactionHash = transaction
  liquidityChange.callIndex = callIndex
  liquidityChange.pool = Pool.load(poolHash)!.id
  liquidityChange.user = userAddress
  liquidityChange.block = blockNumber
  liquidityChange.time = timestamp
  liquidityChange.changeType = changeType
  liquidityChange.positionType = positionType
  liquidityChange.bidTick = bidTick
  liquidityChange.askTick = askTick
  liquidityChange.isBid = isBid
  liquidityChange.liq = liq
  liquidityChange.baseFlow = baseFlow
  liquidityChange.quoteFlow = quoteFlow
  liquidityChange.callSource = callSource
  liquidityChange.pivotTime = pivotTime
  liquidityChange.save()

  // Save new entity ID
  saveCallIndex(entityType, transaction, callIndex)

  if (changeType === "burn" || changeType === "harvest") {
    handleBalanceChange(transaction, blockNumber, timestamp, userAddress, Address.fromBytes(Pool.load(poolHash)!.base))
    handleBalanceChange(transaction, blockNumber, timestamp, userAddress, Address.fromBytes(Pool.load(poolHash)!.quote))
  }
}

// Creates Swap entities
export function handleSwap(transaction: Bytes, userAddress: Address, poolHash: Bytes, blockNumber: BigInt, transactionIndex: BigInt, timestamp: BigInt, isBuy: boolean, inBaseQty: boolean, qty: BigInt, limitPrice: BigInt | null, minOut: BigInt | null, baseFlow: BigInt, quoteFlow: BigInt, callSource: string, dex: string): void {
  // Get unique entity ID
  const entityType = "swap"
  const callIndex = getNextCallIndex(entityType, transaction)

  // Record the swap
  const swap = new Swap(getUniqueCallID(transaction, callIndex))
  swap.transactionHash = transaction
  swap.callIndex = callIndex
  swap.user = userAddress
  swap.block = blockNumber
  swap.transactionIndex = transactionIndex
  swap.time = timestamp
  swap.pool = poolHash
  swap.isBuy = isBuy
  swap.inBaseQty = inBaseQty
  swap.qty = qty
  if (limitPrice !== null) {
    swap.limitPrice = fixedToFloatingPoint(limitPrice)
  }
  swap.minOut = minOut
  swap.baseFlow = baseFlow
  swap.quoteFlow = quoteFlow
  if (quoteFlow.abs() > BigInt.fromI32(0)) {
    swap.price = baseFlow.abs().divDecimal(quoteFlow.abs().toBigDecimal())
  }
  swap.callSource = callSource
  swap.dex = dex
  swap.save()

  // Save new entity ID
  saveCallIndex(entityType, transaction, callIndex)

  if (dex === "croc") {
    handleBalanceChange(transaction, blockNumber, timestamp, userAddress, Address.fromBytes(Pool.load(poolHash)!.base))
    handleBalanceChange(transaction, blockNumber, timestamp, userAddress, Address.fromBytes(Pool.load(poolHash)!.quote))
  }
}

export function handleBalanceChange(transaction: Bytes, blockNumber: BigInt, timestamp: BigInt, user: Address, token: Address): void {
  const balanceHash = getUserBalanceHash(user, token)
  const userBalance = UserBalance.load(balanceHash)
  if (userBalance === null) {
    const userBalance_ = new UserBalance(balanceHash)
    userBalance_.transactionHash = transaction
    userBalance_.block = blockNumber
    userBalance_.time = timestamp
    userBalance_.user = user
    userBalance_.token = token
    userBalance_.save()
  }
}

export function handleFeeChange(transaction: Bytes, blockNumber: BigInt, timestamp: BigInt, poolHash: Bytes, feeRate: i32): void {
  // Get unique entity ID
  const entityType = "feeChange"
  const callIndex = getNextCallIndex(entityType, transaction)

  // Record the fee change
  const feeChange = new FeeChange(getUniqueCallID(transaction, callIndex))
  feeChange.transactionHash = transaction
  feeChange.callIndex = callIndex
  feeChange.block = blockNumber
  feeChange.time = timestamp
  feeChange.pool = poolHash
  feeChange.feeRate = feeRate
  feeChange.save()

  // Save new entity ID
  saveCallIndex(entityType, transaction, callIndex)
}

/*********************** HANDLERS FOR DIRECT SWAP CALLS **********************/

// Handler for a swap() call made to CrocSwapDex
export function handleDirectSwapCall(call: SwapCall): void {
  handleSwap(
    call.transaction.hash,
    call.transaction.from,
    getPoolHash(call.inputs.base, call.inputs.quote, call.inputs.poolIdx),
    call.block.number,
    call.transaction.index,
    call.block.timestamp,
    call.inputs.isBuy,
    call.inputs.inBaseQty,
    call.inputs.qty,
    call.inputs.limitPrice,
    call.inputs.minOut,
    call.outputs.baseQuote,
    call.outputs.quoteFlow,
    "hotpath",
    "croc"
  )
}

// event CrocSwap (address indexed base, address indexed quote, uint256 poolIdx, bool isBuy, bool inBaseQty, uint128 qty, uint16 tip, uint128 limitPrice, uint128 minOut, uint8 reserveFlags, int128 baseFlow, int128 quoteFlow);
export function handleDirectSwapEvent(event: CrocSwap): void {
  handleSwap(
    event.transaction.hash,
    event.transaction.from,
    getPoolHash(event.params.base, event.params.quote, event.params.poolIdx),
    event.block.number,
    event.transaction.index,
    event.block.timestamp,
    event.params.isBuy,
    event.params.inBaseQty,
    event.params.qty,
    event.params.limitPrice,
    event.params.minOut,
    event.params.baseFlow,
    event.params.quoteFlow,
    "hotpath_event",
    "croc"
  )
}

/************************ HANDLERS FOR HOTPROXY SWAPS ************************/

export function handleHotProxy(inputs: Bytes, transaction: ethereum.Transaction, block: ethereum.Block, callSource: string): void {
  const params = decodeAbi(inputs, "(address,address,uint256,bool,bool,uint128,uint16,uint128,uint128,uint8)")
  const base = params[0].toAddress()
  const quote = params[1].toAddress()
  const poolIdx = params[2].toBigInt()
  const isBuy = params[3].toBoolean()
  const inBaseQty = params[4].toBoolean()
  const qty = params[5].toBigInt()
  const limitPrice = params[7].toBigInt()
  const minOut = params[8].toBigInt()
  handleSwap(
    transaction.hash,
    transaction.from,
    getPoolHash(base, quote, poolIdx),
    block.number,
    transaction.index,
    block.timestamp,
    isBuy,
    inBaseQty,
    qty,
    limitPrice,
    minOut,
    BigInt.fromI32(0), // replace
    BigInt.fromI32(0), // replace
    callSource,
    "croc"
  )
}

// Handler for a userCmd() swap call made to HotProxy
export function handleHotProxyCall(call: HotProxyUserCmdCall): void {
  handleHotProxy(call.inputs.input, call.transaction, call.block, "hotproxy")
}

// event CrocHotCmd (bytes input, int128 baseFlow, int128 quoteFlow);
export function handleHotProxyEvent(event: CrocHotCmd): void {
  handleHotProxy(event.params.input, event.transaction, event.block, "hotproxy_event")
}

/******************* HANDLERS FOR COLDPATH USERCMD() CALLS *******************/

export function handleColdPath(inputs: Bytes, transaction: ethereum.Transaction, block: ethereum.Block): void {
  const initPoolCode = 71
  const depositSurplusCode = 73
  const transferSurplusCode = 75

  const cmdCode = inputs[31]
  if (cmdCode === initPoolCode) {
    const params = decodeAbi(inputs, "(uint8,address,address,uint256,uint128)")
    const base = params[1].toAddress()
    const quote = params[2].toAddress()
    const poolIdx = params[3].toBigInt()
    createPool(base, quote, poolIdx)
  } else if (cmdCode === depositSurplusCode || cmdCode === transferSurplusCode) {
    const params = decodeAbi(inputs, "(uint8,address,uint128,address)")
    const recv = params[1].toAddress()
    const token = params[3].toAddress()

    handleBalanceChange(
      transaction.hash,
      block.number,
      block.timestamp,
      recv,
      token
    )
  }
}

// Handler for a ColdPath userCmd call that initializes a new liquidity pool
export function handleColdPathCall(call: ColdPathUserCmdCall): void {
  handleColdPath(call.inputs.cmd, call.transaction, call.block)
}


// event CrocColdCmd (bytes input);
export function handleColdPathEvent(event: CrocColdCmd): void {
  handleColdPath(event.params.input, event.transaction, event.block)
}

/***************** HANDLERS FOR COLDPATH PROTOCOLCMD() CALLS *****************/

export function handleColdPathProtocolCmd(inputs: Bytes, transaction: ethereum.Transaction, block: ethereum.Block): void {
  const poolReviseCode = 111

  const cmdCode = inputs[31]
  if (cmdCode === poolReviseCode) {
    const params = decodeAbi(inputs, "(uint8,address,address,uint256,uint16,uint16,uint8,uint8)")
    const base = params[1].toAddress()
    const quote = params[2].toAddress()
    const poolIdx = params[3].toBigInt()
    const feeRate = params[4].toI32()

    handleFeeChange(
      transaction.hash,
      block.number,
      block.timestamp,
      getPoolHash(base, quote, poolIdx),
      feeRate
    )
  }
}

export function handleColdPathProtocolCmdCall(call: ProtocolCmdCall): void {
  handleColdPathProtocolCmd(call.inputs.cmd, call.transaction, call.block)
}

// event CrocColdProtocolCmd (bytes input);
export function handleColdPathProtocolCmdEvent(event: CrocColdProtocolCmd): void {
  handleColdPathProtocolCmd(event.params.input, event.transaction, event.block)
}

/******************* HANDLERS FOR WARMPATH USERCMD() CALLS *******************/

export function handleWarmPath(inputs: Bytes, transaction: ethereum.Transaction, block: ethereum.Block, baseFlow: BigInt, quoteFlow: BigInt, callSource: string): void {
  const code = inputs[31]
  const isMint = code == 1 || code == 11 || code == 12 || code == 3 || code == 31 || code == 32
  const isBurn = code == 2 || code == 21 || code == 22 || code == 4 || code == 41 || code == 42
  const isHarvest = code == 5

  if (isMint || isBurn || isHarvest) {
    const params = decodeAbi(inputs, "(uint8,address,address,uint256,int24,int24,uint128,uint128,uint128,uint8,address)")
    const base = params[1].toAddress()
    const quote = params[2].toAddress()
    const poolIdx = params[3].toBigInt()
    const poolHash = getPoolHash(base, quote, poolIdx)
    const ambient = code == 3 || code == 31 || code == 32 || code == 4 || code == 41 || code == 42
    const bidTick = ambient ? 0 : params[4].toI32()
    const askTick = ambient ? 0 : params[5].toI32()
    const liq = params[6].toBigInt()
    modifyLiquidity(
      transaction.hash,
      transaction.from,
      block.number,
      block.timestamp,
      poolHash,
      ambient ? "ambient" : "concentrated",
      isMint ? "mint" : (isBurn ? "burn" : "harvest"),
      bidTick,
      askTick,
      false,
      liq,
      baseFlow,
      quoteFlow,
      callSource,
      null
    )
  }
}

// Handler for a WarmPath userCmd call that mints or burns a new liquidity position
export function handleWarmPathCall(call: WarmPathUserCmdCall): void {
  handleWarmPath(call.inputs.input, call.transaction, call.block, call.outputs.baseFlow, call.outputs.quoteFlow, "warmpath")
}

// event CrocWarmCmd (bytes input, int128 baseFlow, int128 quoteFlow);
export function handleWarmPathEvent(event: CrocWarmCmd): void {
  handleWarmPath(event.params.input, event.transaction, event.block, event.params.baseFlow, event.params.quoteFlow, "warmpath_event")
}

/********************* HANDLERS FOR ALL MICROPATHS CALLS *********************/

export function handleMicroPathsLiquidity(transaction: ethereum.Transaction, block: ethereum.Block, poolHash: Bytes, positionType: string, changeType: string, bidTick: i32, askTick: i32, liq: BigInt, baseFlow: BigInt, quoteFlow: BigInt, callSource: string): void {
  modifyLiquidity(
    transaction.hash,
    transaction.from,
    block.number,
    block.timestamp,
    poolHash,
    positionType,
    changeType,
    bidTick,
    askTick,
    false,
    liq,
    baseFlow,
    quoteFlow,
    callSource,
    null
  )

}

// Handler for a MicroPaths mintRange() call (as part of a long-form order) that mints a concentrated liquidity position
export function handleMintRangeCall(call: MintRangeCall): void {
  handleMicroPathsLiquidity(
    call.transaction,
    call.block,
    call.inputs.poolHash,
    "concentrated",
    "mint",
    call.inputs.lowTick,
    call.inputs.highTick,
    call.inputs.liq,
    call.outputs.baseFlow,
    call.outputs.quoteFlow,
    "micropath_mintrange",
  )
}

// event CrocMicroMintRange(bytes input, bytes output);
export function handleMintRangeEvent(event: CrocMicroMintRange): void {
  const inputs = decodeAbi(event.params.input, "(uint128,int24,uint128,uint128,uint64,uint64,int24,int24,uint128,bytes32)")
  const outputs = decodeAbi(event.params.output, "(int128,int128,uint128,uint128)")
  const bidTick = inputs[6].toI32()
  const askTick = inputs[7].toI32()
  const liq = inputs[8].toBigInt()
  const poolHash = inputs[9].toBytes()
  const baseFlow = outputs[0].toBigInt()
  const quoteFlow = outputs[1].toBigInt()

  handleMicroPathsLiquidity(
    event.transaction,
    event.block,
    poolHash,
    "concentrated",
    "mint",
    bidTick,
    askTick,
    liq,
    baseFlow,
    quoteFlow,
    "micropath_mintrange_event",
  )
}

// Handler for a MicroPaths mintAmbient() call (as part of a long-form order) that mints an ambient liquidity position
export function handleMintAmbientCall(call: MintAmbientCall): void {
  handleMicroPathsLiquidity(
    call.transaction,
    call.block,
    call.inputs.poolHash,
    "ambient",
    "mint",
    0,
    0,
    call.inputs.liq,
    call.outputs.baseFlow,
    call.outputs.quoteFlow,
    "micropath_mintambient",
  )
}

// event CrocMicroMintAmbient(bytes input, bytes output);
export function handleMintAmbientEvent(event: CrocMicroMintAmbient): void {
  const inputs = decodeAbi(event.params.input, "(uint128,uint128,uint128,uint64,uint64,uint128,bytes32)")
  const outputs = decodeAbi(event.params.output, "(int128,int128,uint128)")
  const liq = inputs[5].toBigInt()
  const poolHash = inputs[6].toBytes()
  const baseFlow = outputs[0].toBigInt()
  const quoteFlow = outputs[1].toBigInt()

  handleMicroPathsLiquidity(
    event.transaction,
    event.block,
    poolHash,
    "ambient",
    "mint",
    0,
    0,
    liq,
    baseFlow,
    quoteFlow,
    "micropath_mintambient_event",
  )
}

// Handler for a MicroPaths mintRange() call (as part of a long-form order) that burns a concentrated liquidity position
export function handleBurnRangeCall(call: BurnRangeCall): void {
  handleMicroPathsLiquidity(
    call.transaction,
    call.block,
    call.inputs.poolHash,
    "concentrated",
    "burn",
    call.inputs.lowTick,
    call.inputs.highTick,
    call.inputs.liq,
    call.outputs.baseFlow,
    call.outputs.quoteFlow,
    "micropath_burnrange",
  )
}

// event CrocMicroBurnRange(bytes input, bytes output);
export function handleBurnRangeEvent(event: CrocMicroBurnRange): void {
  const inputs = decodeAbi(event.params.input, "(uint128,int24,uint128,uint128,uint64,uint64,int24,int24,uint128,bytes32)")
  const outputs = decodeAbi(event.params.output, "(int128,int128,uint128,uint128)")
  const bidTick = inputs[6].toI32()
  const askTick = inputs[7].toI32()
  const liq = inputs[8].toBigInt()
  const poolHash = inputs[9].toBytes()
  const baseFlow = outputs[0].toBigInt()
  const quoteFlow = outputs[1].toBigInt()

  handleMicroPathsLiquidity(
    event.transaction,
    event.block,
    poolHash,
    "concentrated",
    "burn",
    bidTick,
    askTick,
    liq,
    baseFlow,
    quoteFlow,
    "micropath_burnrange_event",
  )
}

// Handler for a MicroPaths burnAmbient() call (as part of a long-form order) that burns an ambient liquidity position
export function handleBurnAmbientCall(call: BurnAmbientCall): void {
  handleMicroPathsLiquidity(
    call.transaction,
    call.block,
    call.inputs.poolHash,
    "ambient",
    "burn",
    0,
    0,
    call.inputs.liq,
    call.outputs.baseFlow,
    call.outputs.quoteFlow,
    "micropath_burnambient",
  )
}

// event CrocMicroBurnAmbient(bytes input, bytes output);
export function handleBurnAmbientEvent(event: CrocMicroBurnAmbient): void {
  const inputs = decodeAbi(event.params.input, "(uint128,uint128,uint128,uint64,uint64,uint128,bytes32)")
  const outputs = decodeAbi(event.params.output, "(int128,int128,uint128)")
  const liq = inputs[5].toBigInt()
  const poolHash = inputs[6].toBytes()
  const baseFlow = outputs[0].toBigInt()
  const quoteFlow = outputs[1].toBigInt()

  handleMicroPathsLiquidity(
    event.transaction,
    event.block,
    poolHash,
    "ambient",
    "burn",
    0,
    0,
    liq,
    baseFlow,
    quoteFlow,
    "micropath_burnambient_event",
  )
}

// Handler for a MicroPaths sweepSwap() call (as part of a long-form order) that performs a swap operation on a single pool
export function handleSweepSwapCall(call: SweepSwapCall): void {
  handleSwap(
    call.transaction.hash,
    call.transaction.from,
    call.inputs.pool.hash_,
    call.block.number,
    call.transaction.index,
    call.block.timestamp,
    call.inputs.swap.isBuy_,
    call.inputs.swap.inBaseQty_,
    call.inputs.swap.qty_,
    call.inputs.swap.limitPrice_,
    null, // slippage is not checked at the per-swap level in a long-form order
    call.outputs.accum.baseFlow_,
    call.outputs.accum.quoteFlow_,
    "micropath",
    "croc"
  )
}

// event CrocMicroSwap(bytes input, bytes output);
export function handleSweepSwapEvent(event: CrocMicroSwap): void {
  const inputs = decodeAbi(event.params.input, "((uint128,uint128,uint128,uint64,uint64),int24,(bool,bool,uint8,uint128,uint128),((uint8,uint16,uint8,uint16,uint8,uint8,uint8),bytes32,address))")
  const outputs = decodeAbi(event.params.output, "((int128,int128,uint128,uint128),uint128,uint128,uint128,uint64,uint64)")
  const poolHash = inputs[18].toBytes()
  const isBuy = inputs[6].toBoolean()
  const inBaseQty = inputs[7].toBoolean()
  const qty = inputs[9].toBigInt()
  const limitPrice = inputs[10].toBigInt()
  const baseFlow = outputs[0].toBigInt()
  const quoteFlow = outputs[1].toBigInt()

  handleSwap(
    event.transaction.hash,
    event.transaction.from,
    poolHash,
    event.block.number,
    event.transaction.index,
    event.block.timestamp,
    isBuy,
    inBaseQty,
    qty,
    limitPrice,
    null, // slippage is not checked at the per-swap level in a long-form order
    baseFlow,
    quoteFlow,
    "micropath_event",
    "croc"
  )
}

/************** HANDLERS FOR KNOCKOUTLIQPATH KNOCKOUTCMD() CALLS *************/

export function handleKnockoutCmd(inputs: Bytes, transaction: ethereum.Transaction, block: ethereum.Block, baseFlow: BigInt, quoteFlow: BigInt, callSource: string): void {
  const code = inputs[31]
  const isMint = code == 91
  const isBurn = code == 92
  const isClaim = code == 93
  const isRecover = code == 94

  let params: ethereum.Tuple =
    (isMint || isBurn) ?
    decodeAbi(inputs, "(uint8,address,address,uint256,int24,int24,bool,uint8,uint256,uint256,uint128,bool)") :
    decodeAbi(inputs, "(uint8,address,address,uint256,int24,int24,bool,uint8,uint256,uint256,uint32)")

  const base = params[1].toAddress()
  const quote = params[2].toAddress()
  const poolIdx = params[3].toBigInt()
  const poolHash = getPoolHash(base, quote, poolIdx)
  const bidTick = params[4].toI32()
  const askTick = params[5].toI32()
  const isBid = params[6].toBoolean()

  if (isMint || isBurn) {
    const liq = params[10].toBigInt()
    modifyLiquidity(
      transaction.hash,
      transaction.from,
      block.number,
      block.timestamp,
      poolHash,
      "knockout",
      isMint ? "mint" : "burn",
      bidTick,
      askTick,
      isBid,
      liq,
      baseFlow,
      quoteFlow,
      callSource,
      null
    )
  } else if (isRecover) {
    const pivotTime = params[10].toBigInt()
    modifyLiquidity(
      transaction.hash,
      transaction.from,
      block.number,
      block.timestamp,
      poolHash,
      "knockout",
      "recover",
      bidTick,
      askTick,
      isBid,
      null,
      baseFlow,
      quoteFlow,
      callSource,
      pivotTime
    )
  }
}

// Handler for a KnockoutLiqPath userCmd() call that mints, burns, or collects a new knockout liquidity position
export function handleKnockoutCmdCall(call: KnockoutUserCmdCall): void {
  handleKnockoutCmd(call.inputs.cmd, call.transaction, call.block, call.outputs.baseFlow, call.outputs.quoteFlow, "knockout")
}

// event CrocKnockoutCmd (bytes input, int128 baseFlow, int128 quoteFlow);
export function handleKnockoutCmdEvent(event: CrocKnockoutCmd): void {
  handleKnockoutCmd(event.params.input, event.transaction, event.block, event.params.baseFlow, event.params.quoteFlow, "knockout_event")
}

/********************** HANDLER FOR KNOCKOUTCROSS EVENTS *********************/

// Handler for a CrocKnockoutCross event emission
export function handleKnockoutCross(event: CrocKnockoutCross): void { 
  const cross = new KnockoutCross(getKnockoutCrossHash(event.block.number, event.transaction.hash, event.params.pool, event.params.tick, event.params.isBid, event.params.pivotTime, event.params.feeMileage))
  cross.block = event.block.number
  cross.time = event.block.timestamp
  cross.transactionHash = event.transaction.hash
  cross.pool = event.params.pool
  cross.tick = event.params.tick
  cross.isBid = event.params.isBid
  cross.pivotTime = event.params.pivotTime
  cross.feeMileage = event.params.feeMileage
  cross.save()
  
  modifyLiquidity(
    event.transaction.hash,
    event.transaction.from,
    event.block.number,
    event.block.timestamp,
    event.params.pool,
    "knockout",
    "cross",  
    event.params.tick,
    event.params.tick,
    event.params.isBid,
    null,
    null,
    null,
    "knockoutcross",
    event.params.pivotTime
  )
}

