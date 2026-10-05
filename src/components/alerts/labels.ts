/** Textos de las reglas de alertas (compartidos por la lista y la configuración). */
export const RULE_LABEL: Record<string, string> = {
  large_purchase: "Compra fuerte",
  new_merchant_large: "Comercio nuevo con monto alto",
  spending_pace: "Ritmo de gasto",
  daily_spike: "Pico de gasto del día",
  duplicate_suspect: "Posible duplicado",
  unconfirmed: "Cargo sin confirmar",
  goal_off_track: "Meta de ahorro",
  statement_diff: "Diferencia con un estado de cuenta",
  transfer_registered: "Transferencia registrada",
  document_review: "Documento por revisar",
};

export const RULE_HELP: Record<string, string> = {
  large_purchase: "Avisa cuando una compra es mucho más grande de lo habitual o pasa tu monto límite.",
  new_merchant_large: "Avisa de un comercio que nunca habías usado cuando el cargo es alto.",
  spending_pace: "Avisa si vas gastando más rápido que en el mismo periodo del mes pasado.",
  daily_spike: "Avisa si un día gastas varias veces tu promedio diario.",
  duplicate_suspect: "Avisa si el mismo cargo parece haberse registrado dos veces.",
  unconfirmed: "Avisa de cargos del Atajo que el banco no confirmó por correo.",
  goal_off_track: "Avisa si tu ahorro se aleja del ritmo que necesita tu meta.",
  statement_diff: "Avisa si un estado de cuenta trae diferencias contra lo que tienes registrado.",
  transfer_registered: "Avisa cuando se registra una transferencia desde un comprobante.",
  document_review: "Avisa cuando un PDF necesita tu revisión.",
};
