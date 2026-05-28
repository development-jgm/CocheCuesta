const int N = 8;
int buf[N];
int idx  = 0;
long sum = 0;

void setup() {
  Serial.begin(9600);
  for (int i = 0; i < N; i++) buf[i] = analogRead(A0);
  for (int i = 0; i < N; i++) sum += buf[i];
}

void loop() {
  sum -= buf[idx];
  buf[idx] = analogRead(A0);
  sum += buf[idx];
  idx = (idx + 1) % N;

  int pendiente = map(sum / N, 0, 1023, 0, 100);
  pendiente = constrain(pendiente, 0, 100);
  Serial.println(pendiente);
  delay(50);
}
