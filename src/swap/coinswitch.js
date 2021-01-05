// @flow

import { add, div, gt, lt, mul, sub } from 'biggystring'
import {
  type EdgeCorePluginOptions,
  type EdgeCurrencyWallet,
  type EdgeLog,
  type EdgeSpendInfo,
  type EdgeSwapInfo,
  type EdgeSwapPlugin,
  type EdgeSwapQuote,
  type EdgeSwapRequest,
  type EdgeTransaction,
  SwapAboveLimitError,
  SwapBelowLimitError,
  SwapCurrencyError
} from 'edge-core-js/types'

import { makeSwapPluginQuote } from '../swap-helpers.js'

const pluginId = 'coinswitch'

const swapInfo: EdgeSwapInfo = {
  pluginId,
  displayName: 'CoinSwitch',
  supportEmail: 'support@coinswitch.co'
}

const orderUri = 'https://coinswitch.co/app/exchange/transaction/'
const uri = 'https://api.coinswitch.co/'
const expirationMs = 1000 * 60 * 15
const fixedExpirationMs = 1000 * 60 * 5

type QuoteInfo = {
  orderId: string,
  exchangeAddress: {
    address: string,
    tag: string
  },
  expectedDepositCoinAmount: number,
  expectedDestinationCoinAmount: number
}

const dontUseLegacy = {
  DGB: true
}

async function getAddress(
  wallet: EdgeCurrencyWallet,
  currencyCode: string
): Promise<string> {
  const addressInfo = await wallet.getReceiveAddress({ currencyCode })
  return addressInfo.legacyAddress && !dontUseLegacy[currencyCode]
    ? addressInfo.legacyAddress
    : addressInfo.publicAddress
}

function checkReply(log: EdgeLog, reply: Object, request?: EdgeSwapRequest) {
  if (request != null && !reply.data) {
    log.warn(`${pluginId} SwapCurrencyError ${JSON.stringify(request)}`)
    throw new SwapCurrencyError(
      swapInfo,
      request.fromCurrencyCode,
      request.toCurrencyCode
    )
  }
  if (!reply.success) {
    throw new Error(JSON.stringify(reply.code))
  }
}

export function makeCoinSwitchPlugin(
  opts: EdgeCorePluginOptions
): EdgeSwapPlugin {
  const { initOptions, io, log } = opts
  const { fetchCors = io.fetch } = io

  if (initOptions.apiKey == null) {
    throw new Error('No coinswitch apiKey provided.')
  }
  const { apiKey } = initOptions

  async function call(json: any) {
    const body = JSON.stringify(json.params)
    log('call:', json)
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey
    }
    const api = uri + json.route
    const response = await fetchCors(api, { method: 'POST', body, headers })
    if (!response.ok) {
      throw new Error(`CoinSwitch returned error code ${response.status}`)
    }
    const out = await response.json()
    log('reply:', out)
    return out
  }

  const out: EdgeSwapPlugin = {
    swapInfo,

    async fetchSwapQuote(
      request: EdgeSwapRequest,
      userSettings: Object | void
    ): Promise<EdgeSwapQuote> {
      log.warn(`${pluginId} swap requested ${JSON.stringify(request)}`)
      const fixedPromise = this.getFixedQuote(request, userSettings)
      const estimatePromise = this.getEstimate(request, userSettings)
      // try fixed and if error then get estimate
      try {
        const fixedResult = await fixedPromise
        return fixedResult
      } catch (e) {
        const estimateResult = await estimatePromise
        return estimateResult
      }
    },
    async getFixedQuote(
      request: EdgeSwapRequest,
      userSettings: Object | void
    ): Promise<EdgeSwapQuote> {
      const [fromAddress, toAddress] = await Promise.all([
        getAddress(request.fromWallet, request.fromCurrencyCode),
        getAddress(request.toWallet, request.toCurrencyCode)
      ])

      const quoteAmount =
        request.quoteFor === 'from'
          ? await request.fromWallet.nativeToDenomination(
              request.nativeAmount,
              request.fromCurrencyCode
            )
          : await request.toWallet.nativeToDenomination(
              request.nativeAmount,
              request.toCurrencyCode
            )
      const quoteParams =
        request.quoteFor === 'from'
          ? {
              depositCoin: request.fromCurrencyCode.toLowerCase(),
              destinationCoin: request.toCurrencyCode.toLowerCase(),
              depositCoinAmount: quoteAmount
            }
          : {
              depositCoin: request.fromCurrencyCode.toLowerCase(),
              destinationCoin: request.toCurrencyCode.toLowerCase(),
              destinationCoinAmount: quoteAmount
            }

      const quoteReplies = await Promise.all([
        call({
          route: 'v2/fixed/offer',
          params: quoteParams
        }),
        call({
          route: 'v2/fixed/pairs',
          params: {
            depositCoin: quoteParams.depositCoin,
            destinationCoin: quoteParams.destinationCoin
          }
        })
      ])

      checkReply(log, quoteReplies[0], request)
      checkReply(log, quoteReplies[1], request)

      let fromAmount, fromNativeAmount, toNativeAmount
      const offerReferenceId = quoteReplies[0].data.offerReferenceId

      if (request.quoteFor === 'from') {
        fromAmount = quoteAmount
        fromNativeAmount = request.nativeAmount
        const exchangeAmount = quoteReplies[0].data.destinationCoinAmount
        toNativeAmount = await request.toWallet.denominationToNative(
          exchangeAmount,
          request.toCurrencyCode
        )
      } else {
        fromAmount = quoteReplies[0].data.depositCoinAmount
        fromNativeAmount = await request.fromWallet.denominationToNative(
          fromAmount,
          request.fromCurrencyCode
        )
        toNativeAmount = request.nativeAmount
      }

      const [nativeMin, nativeMax] = await Promise.all([
        request.fromWallet.denominationToNative(
          quoteReplies[1].data[0].limitMinDepositCoin.toString(),
          request.fromCurrencyCode
        ),
        request.fromWallet.denominationToNative(
          quoteReplies[1].data[0].limitMaxDepositCoin.toString(),
          request.fromCurrencyCode
        )
      ])

      if (lt(fromNativeAmount, nativeMin)) {
        log.warn(
          `${pluginId} SwapBelowLimitError\n${JSON.stringify(
            swapInfo
          )}\n${nativeMin}`
        )
        throw new SwapBelowLimitError(swapInfo, nativeMin)
      }

      if (gt(fromNativeAmount, nativeMax)) {
        log.warn(
          `${pluginId} SwapAboveLimitError\n${JSON.stringify(
            swapInfo
          )}\n${nativeMax}`
        )
        throw new SwapAboveLimitError(swapInfo, nativeMax)
      }

      const createOrder = await call({
        route: 'v2/fixed/order',
        params: {
          depositCoin: quoteParams.depositCoin.toLowerCase(),
          destinationCoin: quoteParams.destinationCoin.toLowerCase(),
          depositCoinAmount: parseFloat(fromAmount),
          offerReferenceId: offerReferenceId,
          destinationAddress: { address: toAddress, tag: null },
          refundAddress: { address: fromAddress, tag: null }
        }
      })

      checkReply(log, createOrder)
      const quoteInfo: QuoteInfo = createOrder.data

      // Make the transaction:
      const spendInfo: EdgeSpendInfo = {
        currencyCode: request.fromCurrencyCode,
        spendTargets: [
          {
            nativeAmount: fromNativeAmount,
            publicAddress: quoteInfo.exchangeAddress.address,
            uniqueIdentifier: quoteInfo.exchangeAddress.tag
          }
        ],
        networkFeeOption:
          request.fromCurrencyCode.toUpperCase() === 'BTC'
            ? 'high'
            : 'standard',
        swapData: {
          orderId: quoteInfo.orderId,
          orderUri: orderUri + quoteInfo.orderId,
          isEstimate: false,
          payoutAddress: toAddress,
          payoutCurrencyCode: request.toCurrencyCode,
          payoutNativeAmount: toNativeAmount,
          payoutWalletId: request.toWallet.id,
          plugin: { ...swapInfo },
          refundAddress: fromAddress
        }
      }
      log('fixedRate spendInfo', spendInfo)
      const tx: EdgeTransaction = await request.fromWallet.makeSpend(spendInfo)

      const out = makeSwapPluginQuote(
        request,
        fromNativeAmount,
        toNativeAmount,
        tx,
        toAddress,
        'coinswitch',
        false, // isEstimate
        new Date(Date.now() + fixedExpirationMs),
        quoteInfo.orderId
      )
      log.warn(`${pluginId} swap quote ${JSON.stringify(out)}`)
      return out
    },
    async getEstimate(
      request: EdgeSwapRequest,
      userSettings: Object | void
    ): Promise<EdgeSwapQuote> {
      const [fromAddress, toAddress] = await Promise.all([
        getAddress(request.fromWallet, request.fromCurrencyCode),
        getAddress(request.toWallet, request.toCurrencyCode)
      ])

      const quoteAmount =
        request.quoteFor === 'from'
          ? await request.fromWallet.nativeToDenomination(
              request.nativeAmount,
              request.fromCurrencyCode
            )
          : await request.toWallet.nativeToDenomination(
              request.nativeAmount,
              request.toCurrencyCode
            )

      const quoteParams =
        request.quoteFor === 'from'
          ? {
              depositCoin: request.fromCurrencyCode.toLowerCase(),
              destinationCoin: request.toCurrencyCode.toLowerCase(),
              depositCoinAmount: quoteAmount
            }
          : {
              depositCoin: request.fromCurrencyCode.toLowerCase(),
              destinationCoin: request.toCurrencyCode.toLowerCase(),
              destinationCoinAmount: quoteAmount
            }

      const quoteReplies = await Promise.all([
        call({
          route: 'v2/rate',
          params: {
            depositCoin: quoteParams.depositCoin.toLowerCase(),
            destinationCoin: quoteParams.destinationCoin.toLowerCase()
          }
        })
      ])

      checkReply(log, quoteReplies[0], request)

      let fromAmount, fromNativeAmount, toNativeAmount
      const minerFee = quoteReplies[0].data.minerFee.toString()
      const rate = quoteReplies[0].data.rate.toString()

      if (request.quoteFor === 'from') {
        fromAmount = quoteAmount
        fromNativeAmount = request.nativeAmount
        const exchangeAmountBeforeMinerFee = mul(rate, quoteAmount)
        const exchangeAmount = sub(exchangeAmountBeforeMinerFee, minerFee)
        toNativeAmount = await request.toWallet.denominationToNative(
          exchangeAmount,
          request.toCurrencyCode
        )
      } else {
        const exchangeAmountAfterMinerFee = add(quoteAmount, minerFee)
        fromAmount = div(exchangeAmountAfterMinerFee, rate, 16)

        fromNativeAmount = await request.fromWallet.denominationToNative(
          fromAmount,
          request.fromCurrencyCode
        )
        toNativeAmount = request.nativeAmount
      }

      const [nativeMin, nativeMax] = await Promise.all([
        request.fromWallet.denominationToNative(
          quoteReplies[0].data.limitMinDepositCoin.toString(),
          request.fromCurrencyCode
        ),
        request.fromWallet.denominationToNative(
          quoteReplies[0].data.limitMaxDepositCoin.toString(),
          request.fromCurrencyCode
        )
      ])

      if (lt(fromNativeAmount, nativeMin)) {
        log.warn(
          `${pluginId} SwapBelowLimitError\n${JSON.stringify(
            swapInfo
          )}\n${nativeMin}`
        )
        throw new SwapBelowLimitError(swapInfo, nativeMin)
      }

      if (gt(fromNativeAmount, nativeMax)) {
        log.warn(
          `${pluginId} SwapAboveLimitError\n${JSON.stringify(
            swapInfo
          )}\n${nativeMax}`
        )
        throw new SwapAboveLimitError(swapInfo, nativeMax)
      }

      const createOrder = await call({
        route: 'v2/order',
        params: {
          depositCoin: quoteParams.depositCoin.toLowerCase(),
          destinationCoin: quoteParams.destinationCoin.toLowerCase(),
          depositCoinAmount: parseFloat(fromAmount),
          destinationAddress: { address: toAddress, tag: null },
          refundAddress: { address: fromAddress, tag: null }
        }
      })

      checkReply(log, createOrder)
      const quoteInfo: QuoteInfo = createOrder.data

      // Make the transaction:
      const spendInfo = {
        currencyCode: request.fromCurrencyCode,
        spendTargets: [
          {
            nativeAmount: fromNativeAmount,
            publicAddress: quoteInfo.exchangeAddress.address,
            uniqueIdentifier: quoteInfo.exchangeAddress.tag
          }
        ],
        swapData: {
          orderId: quoteInfo.orderId,
          orderUri: orderUri + quoteInfo.orderId,
          isEstimate: true,
          payoutAddress: toAddress,
          payoutCurrencyCode: request.toCurrencyCode,
          payoutNativeAmount: toNativeAmount,
          payoutWalletId: request.toWallet.id,
          plugin: { ...swapInfo },
          refundAddress: fromAddress
        }
      }
      log('estimate spendInfo', spendInfo)
      const tx: EdgeTransaction = await request.fromWallet.makeSpend(spendInfo)

      const out = makeSwapPluginQuote(
        request,
        fromNativeAmount,
        toNativeAmount,
        tx,
        toAddress,
        'coinswitch',
        true,
        new Date(Date.now() + expirationMs),
        quoteInfo.orderId
      )
      log.warn(`${pluginId} swap quote ${JSON.stringify(out)}`)
      return out
    }
  }

  return out
}
