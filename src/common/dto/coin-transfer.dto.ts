export type CoinTransferCounterpartyDto = {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
};

export type CoinTransferDto = {
  id: string;
  createdAt: string;
  amount: number;
  note: string | null;
  direction: 'sent' | 'received' | 'admin_added' | 'admin_removed';
  counterparty: CoinTransferCounterpartyDto;
};

export type CoinTransferReceiptPartyDto = {
  userId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

export type CoinTransferReceiptDto = {
  id: string;
  createdAt: string;
  amount: number;
  note: string | null;
  direction: 'sent' | 'received' | 'admin_added' | 'admin_removed';
  sender: CoinTransferReceiptPartyDto;
  recipient: CoinTransferReceiptPartyDto;
  counterparty: CoinTransferCounterpartyDto;
};

export type TransferCoinsRequest = {
  recipientUsername: string;
  amount: number;
  note?: string | null;
};

export type TransferCoinsResponse = {
  transferId: string;
  amount: number;
  recipientUsername: string;
  senderBalanceAfter: number;
};
