import {
  sendProposal,
  buyContract,
  sellContract,
  getPortfolio,
  cancelAll,
} from './f.js';

// Utility to get form values
const $ = id => document.getElementById(id);

$('proposalBtn').onclick = () => {
  sendProposal({
    symbol: $('symbolInput').value,
    amount: parseFloat($('amountInput').value),
    duration: parseInt($('durationInput').value),
    contract_type: $('typeInput').value,
  });
};

$('buyBtn').onclick = () => {
  const id = $('proposalIdInput').value;
  buyContract(id);
};

$('sellBtn').onclick = () => {
  const contractId = $('contractIdInput').value;
  sellContract(contractId);
};

$('portfolioBtn').onclick = getPortfolio;
$('cancelAllBtn').onclick = cancelAll;

