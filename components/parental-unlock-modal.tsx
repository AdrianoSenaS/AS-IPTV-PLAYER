import React, { useState } from 'react';
import { Modal, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { StreamingTheme } from '@/constants/streaming-theme';

type Props = {
  visible: boolean;
  onClose: () => void;
  onConfirm: (pin: string) => Promise<void> | void;
  title?: string;
  subtitle?: string;
  confirmLabel?: string;
  pinPlaceholder?: string;
};

export function ParentalUnlockModal({
  visible,
  onClose,
  onConfirm,
  title = 'Conteudo protegido',
  subtitle = 'Digite o PIN mestre para liberar categorias e imagens.',
  confirmLabel = 'Desbloquear',
  pinPlaceholder = 'PIN mestre',
}: Props) {
  const [pin, setPin] = useState('');

  const handleConfirm = async () => {
    await onConfirm(pin);
    setPin('');
  };

  const handleClose = () => {
    setPin('');
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>

          <TextInput
            style={styles.input}
            value={pin}
            onChangeText={(value) => setPin(value.replace(/[^0-9]/g, ''))}
            keyboardType="numeric"
            secureTextEntry
            placeholder={pinPlaceholder}
            placeholderTextColor={StreamingTheme.colors.textMuted}
            maxLength={8}
          />

          <View style={styles.actionsRow}>
            <TouchableOpacity style={[styles.btn, styles.btnMuted]} onPress={handleClose}>
              <Text style={styles.btnMutedText}>Cancelar</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={handleConfirm}>
              <Text style={styles.btnPrimaryText}>{confirmLabel}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(16,21,37,0.96)',
    padding: 14,
    gap: 10,
  },
  title: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 18,
    fontWeight: '900',
  },
  subtitle: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  input: {
    height: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    paddingHorizontal: 12,
    color: StreamingTheme.colors.textPrimary,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  btn: {
    flex: 1,
    minHeight: 42,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnMuted: {
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
  },
  btnPrimary: {
    borderColor: 'rgba(255,59,48,0.5)',
    backgroundColor: 'rgba(255,59,48,0.24)',
  },
  btnMutedText: {
    color: StreamingTheme.colors.textSecondary,
    fontWeight: '700',
  },
  btnPrimaryText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
  },
});
