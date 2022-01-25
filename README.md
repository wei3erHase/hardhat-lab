# Hardhat Lab

Hardhat Lab is an interactive programming environment with Jupyter for JavaScript and TypeScript users.
You can write and execute ethers code interactively on browsers and save results as Jupyter notebooks.

## Features

- [TSLab](https://github.com/yunabe/tslab): interactive TypeScript programming for Jupyter Notebooks
- [Smock](https://smock.readthedocs.io/en/latest/#): the Solidity mocking library
- [ETH-SDK](https://github.com/dethcrypto/eth-sdk): lightweight SDK for your Ethereum smart contracts
- [Plotly for TSLab](https://github.com/dbuezas/tslab-plotly): Plotly support for Typescript Jupyter notebooks

## Installing tslab
Previous to follow [ts-lab installation guide](https://github.com/yunabe/tslab#installing-tslab), it is necessary that you [install cmake](https://github.com/yunabe/tslab/issues/62):
`brew install cmake`

## Using Typechained
TSLab seems to ignore folders outside of `node_modules/` or the folder where the notebook is being run `notebooks/`. To be able to access `./typechained`, a [workarround](https://github.com/yunabe/tslab/issues/63) can be to create a system link inside the `node_modules` folder.
```
cd node_modules/
ln -s ../typechained @typechained
```
