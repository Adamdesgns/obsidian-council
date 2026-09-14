-- P2-6f: persist directed-chain state on the root (owner) message row
ALTER TABLE messages ADD COLUMN chain TEXT;
ALTER TABLE messages ADD COLUMN chain_hop INTEGER;