import { BottomTabBarButtonProps } from '@react-navigation/bottom-tabs';
import { PlatformPressable } from '@react-navigation/elements';
import * as Haptics from 'expo-haptics';
import { useRef } from 'react';

export function HapticTab(props: BottomTabBarButtonProps) {
  const lastPressAtRef = useRef(0);

  return (
    <PlatformPressable
      {...props}
      style={[props.style, { transform: [{ scale: props.accessibilityState?.selected ? 1.02 : 1 }] }]}
      onPress={(ev) => {
        const now = Date.now();

        // Evita navegação duplicada em toques muito rápidos na mesma aba.
        if (now - lastPressAtRef.current < 120) {
          return;
        }

        lastPressAtRef.current = now;
        props.onPress?.(ev);
      }}
      onPressIn={(ev) => {
        if (process.env.EXPO_OS === 'ios') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
        props.onPressIn?.(ev);
      }}
    />
  );
}
