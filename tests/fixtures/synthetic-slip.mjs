// Synthetic PDF fixtures only. No seller or buyer records are used.
export const ORDER = 'ABCD1234-EF5678-9ABCD';
export const OTHER_ORDER = 'ZZZZ9999-XX0000-12345';
export function syntheticSlip(orderId = ORDER) {
  const lines = ['Ship To:', 'Synthetic Recipient', '100 Example St', 'Example City, VA 00000', `Order Number: ${orderId}`, 'Quantity  Description', '1  Synthetic Card', 'Synthetic Shop'];
  const stream = 'BT /F1 12 Tf 36 746 Td 18 TL\n' + lines.map(line => `(${line}) Tj T*`).join('\n') + '\nET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
