import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { createNft, findMasterEditionPda, findMetadataPda, MPL_TOKEN_METADATA_PROGRAM_ID, mplTokenMetadata, verifySizedCollectionItem } from '@metaplex-foundation/mpl-token-metadata';
import { KeypairSigner, PublicKey, createSignerFromKeypair, generateSigner, keypairIdentity, percentAmount, publicKey } from '@metaplex-foundation/umi';
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Marketplace } from "../target/types/marketplace";

describe("marketplace", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.marketplace as Program<Marketplace>;
  console.log("Using Program ID:", program.programId.toString());

  const connection = provider.connection;
  const umi = createUmi(provider.connection);
  const payer = provider.wallet;

  let nftMint: KeypairSigner = generateSigner(umi);
  let collectionMint: KeypairSigner = generateSigner(umi);

  const creatorWallet = umi.eddsa.createKeypairFromSecretKey(new Uint8Array(payer.payer.secretKey));
  const creator = createSignerFromKeypair(umi, creatorWallet);

  let makerAta: anchor.web3.PublicKey;
  let takerAta: anchor.web3.PublicKey;
  let vault: anchor.web3.PublicKey;

  const maker = Keypair.generate();
  const taker = Keypair.generate();

  const price = new anchor.BN(0.01 * LAMPORTS_PER_SOL); // Reduced from 0.05 to 0.01 SOL

  const marketplace = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("marketplace")], program.programId)[0];
  const treasury = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("treasury"), marketplace.toBuffer()], program.programId)[0];
  let listing = anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("listing"),
      marketplace.toBuffer(),
      maker.publicKey.toBuffer(),
      new anchor.web3.PublicKey(nftMint.publicKey).toBuffer(),
    ],
    program.programId
  )[0];

  before(async () => {
    umi.use(keypairIdentity(creator));
    umi.use(mplTokenMetadata());
    console.log("UMI");

    // Airdrop SOL to maker and taker
    // Transfer SOL from provider.wallet to maker and taker
    const transferSol = async (to: anchor.web3.PublicKey, amountSol: number) => {
      const tx = new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: provider.publicKey,
          toPubkey: to,
          lamports: amountSol * LAMPORTS_PER_SOL,
        })
      );

      const sig = await provider.sendAndConfirm(tx, [provider.wallet.payer]);
      console.log(`Transferred ${amountSol} SOL to ${to.toBase58()}. Tx: ${sig}`);
    };

    await transferSol(maker.publicKey, 0.5); // Increased from 0.2 to 0.5 to ensure rent-exempt balance after purchase
    await transferSol(taker.publicKey, 1.0); // Increased from 0.5 to 1.0 to have plenty of SOL for rent exemption

    await sleep(2000);

    // Mint Collection NFT
    await createNft(umi, {
      mint: collectionMint,
      name: "GM",
      symbol: "GM",
      uri: "https://arweave.net/123",
      sellerFeeBasisPoints: percentAmount(5.5),
      collectionDetails: { __kind: 'V1', size: 10 }
    }).sendAndConfirm(umi);
    console.log(`Created Collection NFT: ${collectionMint.publicKey.toString()}`);

    // Mint NFT into maker's ATA
    await createNft(umi, {
      mint: nftMint,
      name: "GM",
      symbol: "GM",
      uri: "https://arweave.net/123",
      sellerFeeBasisPoints: percentAmount(5.5),
      collection: { verified: false, key: collectionMint.publicKey },
      tokenOwner: publicKey(maker.publicKey) // Corrected to use maker's public key
    }).sendAndConfirm(umi);
    console.log(`Created NFT: ${nftMint.publicKey.toString()}`);

    // Verify Collection
    const collectionMetadata = findMetadataPda(umi, { mint: collectionMint.publicKey });
    const collectionMasterEdition = findMasterEditionPda(umi, { mint: collectionMint.publicKey });
    const nftMetadata = findMetadataPda(umi, { mint: nftMint.publicKey });
    await verifySizedCollectionItem(umi, {
      metadata: nftMetadata,
      collectionAuthority: creator,
      collectionMint: collectionMint.publicKey,
      collection: collectionMetadata,
      collectionMasterEditionAccount: collectionMasterEdition,
    }).sendAndConfirm(umi);
    console.log("Collection NFT Verified!");

    // Get or create ATAs
    makerAta = (await getOrCreateAssociatedTokenAccount(
      connection,
      maker,
      new anchor.web3.PublicKey(nftMint.publicKey),
      maker.publicKey
    )).address;

    // Create taker ATA after SOL transfer - use provider wallet as payer
    takerAta = (await getOrCreateAssociatedTokenAccount(
      connection,
      provider.wallet.payer, // Use provider wallet as payer
      new anchor.web3.PublicKey(nftMint.publicKey),
      taker.publicKey
    )).address;

    vault = await anchor.utils.token.associatedAddress({
      mint: new anchor.web3.PublicKey(nftMint.publicKey),
      owner: listing,
    });
  });

  it("Initialize Marketplace!", async () => {
    const tx = await program.methods.initializeMarketplace(1)
      .accountsPartial({
        admin: provider.wallet.publicKey,
        marketplace,
        treasury,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .rpc();
    console.log("Marketplace Initialized. Tx:", tx);
  });

  it("Listing!", async () => {
    const nftMetadata = findMetadataPda(umi, { mint: nftMint.publicKey });
    const nftEdition = findMasterEditionPda(umi, { mint: nftMint.publicKey });

    const tx = await program.methods.listNft(price)
      .accountsPartial({
        seller: maker.publicKey,
        nft: nftMint.publicKey,
        listing,
        listingTokenAccount: vault,
        sellerTokenAccount: makerAta,
        marketplace,
        collectionMint: collectionMint.publicKey,
        metadata: new anchor.web3.PublicKey(nftMetadata[0]),
        masterEdition: new anchor.web3.PublicKey(nftEdition[0]),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        metadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID
      })
      .signers([maker])
      .rpc();
    console.log("\nListing Initialized!");
    console.log("Your transaction signature", tx);
  });

  it("Delisting!", async () => {
    const tx = await program.methods.delistNft()
      .accountsPartial({
        seller: maker.publicKey,
        nft: nftMint.publicKey,
        sellerTokenAccount: makerAta,
        listing,
        listingTokenAccount: vault,
        marketplace,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();
    console.log("\nDelisting Initialized!");
    console.log("Your transaction signature", tx);
  });

  it("Listing Again!", async () => {
    // Create a new listing account since the previous one was closed during delisting
    const newListing = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("listing"),
        marketplace.toBuffer(),
        maker.publicKey.toBuffer(),
        new anchor.web3.PublicKey(nftMint.publicKey).toBuffer(),
      ],
      program.programId
    )[0];

    // Create a new vault for the new listing
    const newVault = await anchor.utils.token.associatedAddress({
      mint: new anchor.web3.PublicKey(nftMint.publicKey),
      owner: newListing,
    });

    const nftMetadata = findMetadataPda(umi, { mint: nftMint.publicKey });
    const nftEdition = findMasterEditionPda(umi, { mint: nftMint.publicKey });

    const tx = await program.methods.listNft(price)
      .accountsPartial({
        seller: maker.publicKey,
        nft: nftMint.publicKey,
        listing: newListing,
        listingTokenAccount: newVault,
        sellerTokenAccount: makerAta,
        marketplace,
        collectionMint: collectionMint.publicKey,
        metadata: new anchor.web3.PublicKey(nftMetadata[0]),
        masterEdition: new anchor.web3.PublicKey(nftEdition[0]),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        metadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID
      })
      .signers([maker])
      .rpc();
    console.log("\nListing Again Initialized!");
    console.log("Your transaction signature", tx);

    // Update the global variables for the purchase test
    listing = newListing;
    vault = newVault;
  });

  it("Purchase Initialized!", async () => {
    // Ensure buyer's token account exists before purchase
    const buyerAtaInfo = await connection.getAccountInfo(takerAta);
    if (!buyerAtaInfo) {
      console.log("Creating buyer's token account before purchase...");
      const createAtaTx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          provider.wallet.payer.publicKey,
          takerAta,
          taker.publicKey,
          new anchor.web3.PublicKey(nftMint.publicKey)
        )
      );
      await provider.sendAndConfirm(createAtaTx);
    }

    // Check balances before purchase
    const buyerBalance = await connection.getBalance(taker.publicKey);
    const sellerBalance = await connection.getBalance(maker.publicKey);
    console.log(`Buyer balance before purchase: ${buyerBalance / LAMPORTS_PER_SOL} SOL`);
    console.log(`Seller balance before purchase: ${sellerBalance / LAMPORTS_PER_SOL} SOL`);

    const tx = await program.methods.purchaseNft()
      .accountsPartial({
        buyer: taker.publicKey,
        seller: maker.publicKey,
        nft: nftMint.publicKey,
        marketplace,
        buyerTokenAccount: takerAta,
        listingTokenAccount: vault,
        listing,
        treasury,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID
      })
      .signers([taker])
      .rpc();
    console.log("\nPurchase Initialized!");
    console.log("Your transaction signature", tx);
  });
});

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}