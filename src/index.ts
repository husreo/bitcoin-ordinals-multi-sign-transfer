import express, { Application, Request, Response } from 'express';
import dotenv from "dotenv";
import bodyParser from "body-parser";
import cors from "cors";
import axios from 'axios';
import * as Bitcoin from "bitcoinjs-lib";
import ecc from "@bitcoinerlab/secp256k1";
Bitcoin.initEccLib(ecc);
import { ECPairFactory } from "ecpair";
const ECPair = ECPairFactory(ecc);

dotenv.config();

const app: Application = express();
const port: number | string = process.env.PORT || 8000;

app.use(cors({ credentials: true, origin: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const network = Bitcoin.networks.testnet;
const privateKey = process.env.PRIVATE_KEY;

if (!privateKey) {
  throw new Error('PRIVATE_KEY environment variable is not set');
}
const keyPair = ECPair.fromWIF(privateKey, network);

const fetchTransaction = async (txid: string) => {
  try {
    const response = await axios.get(`https://mempool.space/testnet/api/tx/${txid}/hex`, {
      timeout: 5000, // Increase the timeout to 5 seconds
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching transaction:', error);
    throw error;
  }
}

const checkFullRBF = (rawTx: string) => {
  const tx = Bitcoin.Transaction.fromHex(rawTx);
  const isFullRBF = tx.ins.some(input => input.sequence < 0xfffffffe);
  if (isFullRBF) {
    console.log('The transaction can be applied RBF.');
  } else {
    console.log('The transaction cannot be applied RBF.');
  }
  return isFullRBF;
};

const fetchPrevTransaction = async (txid: string) => {
  try {
    const response = await axios.get(`https://mempool.space/testnet/api/tx/${txid}/hex`, {
      timeout: 5000, // Increase the timeout to 5 seconds
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching previous transaction:', error);
    throw error;
  }
}

const modifyAndBroadcastTransaction = async (rawTx: string, newAddress: string) => {
  const tx = Bitcoin.Transaction.fromHex(rawTx);
  const psbt = new Bitcoin.Psbt({ network });

  // Fetch the raw transactions for each input
  const prevTxs = await Promise.all(tx.ins.map(async (input) => {
    const prevTxId = Buffer.from(input.hash).reverse().toString('hex');
    return await fetchPrevTransaction(prevTxId);
  }));

  // Add inputs
  tx.ins.forEach((input, index) => {
    psbt.addInput({
      hash: input.hash.reverse().toString('hex'),
      index: input.index,
      nonWitnessUtxo: Buffer.from(prevTxs[index], 'hex'),
      sequence: input.sequence, // Preserve RBF capability
    });
  });

  // Calculate the total input value
  const inputValue = tx.outs.reduce((sum, output) => sum + output.value, 0);
  console.log(tx.outs);
  
  // Set a higher fee (in satoshis)
  const feeIncrease = 500; // Increase the fee by 2000 satoshis (adjust as needed)

  // Calculate the new output value after increasing the fee
  const outputValue = inputValue - feeIncrease;
  psbt.addOutput({
    address: newAddress,
    value: outputValue,
  });

  // Sign all inputs with the private key
  const signValue=psbt.signAllInputs(keyPair);
  console.log("======>",signValue);
  
  // Finalize and extract the transaction
  psbt.finalizeAllInputs();
  const finalTx = psbt.extractTransaction();
  const txHex = finalTx.toHex();

  // Broadcast the transaction
  try {
    const response = await axios.post('https://api.blockcypher.com/v1/btc/test3/txs/push', { tx: txHex }, {
      timeout: 5000, // Increase the timeout to 5 seconds
    });
    console.log('Transaction broadcasted:', response.data);
    return response.data;
  } catch (error: any) {
    console.error('Error broadcasting transaction:', error.response ? error.response.data : error.message);
    throw error;
  }
}

app.get('/', async (req: Request, res: Response) => {
  const txid = 'e65882c0c2e0384eb542c92e4a55897693bffcdf0d6b43aea3bcfd9c37cd4a17'; // Example transaction ID
  const newAddress = 'tb1pwc08hjtg4nkaj390u7djryft2z3l4lea4zvepqnpj2adsr4ujzcs3nzcpc'; // Replace with your actual address

  try {
    const rawTx = await fetchTransaction(txid);
    const rbfResult = checkFullRBF(rawTx);
    if (rbfResult) {
      const broadcastResult = await modifyAndBroadcastTransaction(rawTx, newAddress);
      res.send(`Transaction successfully rebroadcasted. TxID: ${broadcastResult.tx.hash}`);
    } else {
      res.send('The transaction cannot be applied RBF.');
    }
  } catch (error:any) {
    console.error('Final Error:', error.response ? error.response.data : error.message);
    res.status(500).send('Error processing transaction');
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
