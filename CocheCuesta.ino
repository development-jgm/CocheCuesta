void setup() {
  Serial.begin(9600);
}

void loop() {
  int raw = analogRead(A0);
  int pendiente = map(raw, 0, 1023, 0, 100);
  Serial.println(pendiente);
  delay(50);
}
