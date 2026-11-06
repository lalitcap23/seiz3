#!/usr/bin/env python3
"""Move an address's HyperEVM transactions into big blocks (30M gas, about one a minute) or back to small blocks
(3M gas, every second). The vault and the v4 PoolManager don't fit in a small block.

The switch is a HyperCore action (evmUserModify), so the address needs a HyperCore account first.
Needs `pip install hyperliquid-python-sdk`.

  DEPLOYER_PRIVATE_KEY=0x… python3 scripts/big-blocks.py on|off [mainnet]
"""
import os
import sys

from eth_account import Account
from hyperliquid.exchange import Exchange
from hyperliquid.utils import constants

if len(sys.argv) < 2 or sys.argv[1] not in ("on", "off"):
    sys.exit("usage: big-blocks.py on|off [mainnet]")

wallet = Account.from_key(os.environ["DEPLOYER_PRIVATE_KEY"])
url = constants.MAINNET_API_URL if sys.argv[2:] == ["mainnet"] else constants.TESTNET_API_URL
print(wallet.address, Exchange(wallet, url).use_big_blocks(sys.argv[1] == "on"))
