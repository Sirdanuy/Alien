import { PublicKey, Transaction, Connection, Keypair } from '@solana/web3.js'
import { Wallet, BN } from "@project-serum/anchor";
import { NextApiRequest, NextApiResponse } from "next";
import {
  findRewardDistributorId,
  findRewardEntryId,
} from '@cardinal/staking/dist/cjs/programs/rewardDistributor/pda'
import {
  getRewardDistributor,
  getRewardEntry,
} from '@cardinal/staking/dist/cjs/programs/rewardDistributor/accounts'
import { tryGetAccount } from '@cardinal/common'
import { findStakeEntryIdFromMint } from '@cardinal/staking/dist/cjs/programs/stakePool/utils'
import {
  withUpdateRewardEntry,
} from '@cardinal/staking/dist/cjs/programs/rewardDistributor/transaction'
import { programs, MetadataJson } from "@metaplex/js"
import axios from "axios"
import { executeTransaction } from '@cardinal/staking'
import { initRewardEntry } from '@cardinal/staking/dist/cjs/programs/rewardDistributor/instruction';

const {
  metadata: { Metadata },
} = programs


export type NFT = {
  mint: PublicKey
  onchainMetadata: programs.metadata.MetadataData
  externalMetadata: MetadataJson
}



/*  
 * Returns a signed instruction to refresh the yielding rate
*/
export default async (req: NextApiRequest, res: NextApiResponse) => {

  if (req.method !== 'POST') {
    res.status(405).send({ message: 'Only POST requests allowed' })
  }

  const body = req.body
  console.log('body:', body)
  const mint = new PublicKey(body.mint)
  const userPubkey = new PublicKey(body.userPubkey)
  const stakePoolKey = new PublicKey(body.stakePoolKey)

  // Initialize a connection to the blockchain
  const endpoint = process.env.MAINNET_PRIMARY!
  const connection = new Connection(endpoint)

  try {
    // Load the staking admin keypair
    const keypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(process.env.STAKING_ADMIN_PRIVATE_KEY!))
    )
    const wallet = new Wallet(keypair)
    let transaction = new Transaction()

    const [rewardDistributorId] = await findRewardDistributorId(
      stakePoolKey
    )
    const rewardDistributor = await tryGetAccount(() =>
      getRewardDistributor(connection, rewardDistributorId)
    )
    if (!rewardDistributor) {
      throw 'Reward Distributor for pool not found'
    }

    const expectedYield = await computeExpectedYield(mint, connection)
    const expectedMultiplier = expectedYield * (10 ** rewardDistributor.parsed.multiplierDecimals)
    console.log(`Expected multiplier: ${expectedMultiplier}`)

    const [stakeEntryId] = await findStakeEntryIdFromMint(
      connection,
      userPubkey,
      stakePoolKey,
      mint
    )

    const [rewardEntryId] = await findRewardEntryId(
      rewardDistributor.pubkey,
      stakeEntryId
    )
    console.log(`fetching reward entry data for entry id: ${rewardEntryId.toString()}`)
    const rewardEntryData = await tryGetAccount(() => getRewardEntry(connection, rewardEntryId))

    if (!rewardEntryData) {
      console.log(`Adding instruction to initialize reward entry`)
      transaction.add(
        initRewardEntry(connection, wallet, {
          stakeEntryId: stakeEntryId,
          rewardDistributor: rewardDistributor.pubkey,
          rewardEntryId: rewardEntryId,
        })
      );
    } else {
      const currentMultiplier = (
        rewardEntryData.parsed.multiplier.toNumber() /
        10 ** rewardDistributor.parsed.multiplierDecimals
      )
      console.log(`Current multiplier: ${currentMultiplier.toString()}`)

      if (currentMultiplier === expectedMultiplier) {
        console.log(`Multiplier doesn't need to be updated`)
        res.status(200).send({ message: `Yield already set to ${expectedYield} $HAY/day`, type: 'ignored', yieldRate: expectedYield })
        return
      }
    }

    transaction = await withUpdateRewardEntry(
      transaction,
      connection,
      wallet,
      {
        stakePoolId: stakePoolKey,
        rewardDistributorId: rewardDistributor.pubkey,
        stakeEntryId: stakeEntryId,
        multiplier: new BN(expectedMultiplier),
      }
    )

    console.log(`Executing transaction`)
    await executeTransaction(
      connection,
      wallet as Wallet,
      transaction,
      { signers: [keypair] },
    )

    console.log('sending response')
    res.status(200).send({ message: 'Yield rate was successfully updated', type: 'ok', yieldRate: expectedYield })

  } catch (error: any) {
    console.log(error)
    res.status(500).send({ message: 'Yield refresh transaction could not be created', type: 'error' })
  }
}


async function computeExpectedYield(mint: PublicKey, connection: Connection) {

  // Fetch the metadata of the agent and the trait
  const nft = await getNFTMetadata(mint.toString(), connection)

  const attributes = nft?.externalMetadata.attributes

  let hayYield = 2

  // +2 for Legendary skins
  const legendarySkins = [
    "Abstract Colors", "Bat", "Crystal", "Demon", "Dragon", "Gold", "Lava",
  ]
  const skin = attributes?.filter(att => att.trait_type === "Skin")[0]
  if (skin?.value && legendarySkins.includes(skin.value)) {
    hayYield += 2
  }

  // Badges
  const badge = attributes?.filter(att => att.trait_type === "Badge")
  if (badge && badge?.length > 0) {
    const value = badge[0]?.value

    if (value === "Bronze") { hayYield += 5 }
    else if (value === "Silver") { hayYield += 7 }
    else if (value === "Gold") { hayYield += 9 }
    else if (value === "Platinum") { hayYield += 11 }
    else if (value === "Diamond") { hayYield += 15 }
    else {
      console.log(`Badge ${value} unrecognised`)
    }
  }

  // +5 for Imposters
  const imposter = attributes?.filter(att => att.trait_type === "Vignette")[0]
  if (imposter && imposter?.value === "Alpaca") {
    hayYield += 5
  }

  return hayYield
}


export async function getNFTMetadata(
  mint: string,
  connection: Connection,
): Promise<NFT | undefined> {
  try {
    const metadataPDA = await Metadata.getPDA(mint)
    const onchainMetadata = (await Metadata.load(connection, metadataPDA)).data
    const externalMetadata = (await axios.get(onchainMetadata.data.uri)).data

    return {
      mint: new PublicKey(mint),
      onchainMetadata,
      externalMetadata,
    }
  } catch (e) {
    console.log(`failed to pull metadata for token ${mint}`)
  }
}