import { Stack } from 'expo-router';
import React from 'react';

export default function TvLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'fade_from_bottom',
      }}
    >
      <Stack.Screen name="home" options={{ headerShown: false }} />
      <Stack.Screen name="lista" options={{ headerShown: false }} />
      <Stack.Screen name="categoria" options={{ headerShown: false }} />
      <Stack.Screen name="detalhe" options={{ headerShown: false }} />
      <Stack.Screen name="player" options={{ headerShown: false }} />
    </Stack>
  );
}
