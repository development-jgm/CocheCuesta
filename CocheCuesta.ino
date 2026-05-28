const int N = 8;
int buf_brake[N], buf_clutch[N];
int idx       = 0;
long sum_brake = 0, sum_clutch = 0;

void setup() {
  Serial.begin(9600);
  for (int i = 0; i < N; i++) {
    buf_brake[i]  = analogRead(A0);
    buf_clutch[i] = analogRead(A1);
    sum_brake  += buf_brake[i];
    sum_clutch += buf_clutch[i];
  }
}

void loop() {
  sum_brake  -= buf_brake[idx];
  buf_brake[idx]  = analogRead(A0);
  sum_brake  += buf_brake[idx];

  sum_clutch -= buf_clutch[idx];
  buf_clutch[idx] = analogRead(A1);
  sum_clutch += buf_clutch[idx];

  idx = (idx + 1) % N;

  int brake  = constrain(map(sum_brake  / N, 0, 1023, 0, 100), 0, 100);
  int clutch = constrain(map(sum_clutch / N, 0, 1023, 0, 100), 0, 100);

  Serial.print(brake);
  Serial.print(",");
  Serial.println(clutch);
  delay(50);
}
