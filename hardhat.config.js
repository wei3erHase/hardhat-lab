require('@nomiclabs/hardhat-ethers');
require('@nomiclabs/hardhat-web3');
require('dotenv').config();
require('@typechain/hardhat');
require('@typechain/hardhat/dist/type-extensions');
require('tsconfig-paths/register');

module.exports = {
  defaultNetwork: 'hardhat',
  networks: {
    hardhat: {
      hardfork: 'london',
      allowUnlimitedContractSize: true,
      gasPrice: 'auto',
      forking: {
        url: 'https://eth-mainnet.alchemyapi.io/v2/u00W7u55YuNg2jblv7LqCEhyMjso8sQY',
      },
    },
  },
  solidity: {
    version: '0.8.7',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      outputSelection: {
        '*': {
          '*': ['storageLayout'],
        },
      },
    },
  },
  typechain: {
    outDir: 'typechained',
    target: 'ethers-v5',
  },
};
