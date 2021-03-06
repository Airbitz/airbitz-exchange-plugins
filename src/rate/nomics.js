// @flow

import { asArray, asObject, asString } from 'cleaners'
import {
  type EdgeCorePluginOptions,
  type EdgeRatePlugin
} from 'edge-core-js/types'

const asNomicsResponse = asArray(
  asObject({
    price: asString
  })
)

function checkIfFiat(code: string): boolean {
  if (code.indexOf('iso:') >= 0) return true
  return false
}

export function makeNomicsPlugin(opts: EdgeCorePluginOptions): EdgeRatePlugin {
  const { io, initOptions, log } = opts
  const { fetchCors = io.fetch } = io
  const { apiKey } = initOptions

  if (apiKey == null) {
    throw new Error('No Nomics exchange rates API key provided')
  }
  return {
    rateInfo: {
      pluginId: 'nomics',
      displayName: 'Nomics'
    },

    async fetchRates(pairsHint) {
      const pairs = []
      for (const pair of pairsHint) {
        // Skip if codes are both fiat or crypto
        if (
          (checkIfFiat(pair.fromCurrency) && checkIfFiat(pair.toCurrency)) ||
          (!checkIfFiat(pair.fromCurrency) && !checkIfFiat(pair.toCurrency))
        )
          continue
        const fiatCode = pair.toCurrency.split(':')
        try {
          const reply = await fetchCors(
            `https://api.nomics.com/v1/currencies/ticker?key=${apiKey}&ids=${pair.fromCurrency}&convert=${fiatCode[1]}`
          )
          if (reply.status === 429) continue
          const jsonData = await reply.json()
          const rate = Number(asNomicsResponse(jsonData)[0].price)
          pairs.push({
            fromCurrency: pair.fromCurrency,
            toCurrency: pair.toCurrency,
            rate
          })
        } catch (e) {
          log.warn(
            `Issue with Nomics rate data structure for ${pair.fromCurrency}/${pair.toCurrency} pair. Error: ${e}`
          )
        }
      }
      return pairs
    }
  }
}
